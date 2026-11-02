import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createOrderApp} from '../src/modules/modulo-1-pedidos/lab-http.ts';
import {hashPassword} from '../src/modules/modulo-1-pedidos/lab-auth.ts';
import {listBuyerOrders} from '../src/modules/modulo-1-pedidos/checkout.ts';

const db=process.env.PG_CI_URL||'';
const enabled=db.includes('/tala_core_v2_test');
const key=()=> 'command-'+randomUUID();

async function serve(pool){
  const server=createOrderApp(pool).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const base='http://127.0.0.1:'+address.port;
  async function request(method,path,body,cookie,extra={}){
    const response=await fetch(base+path,{
      method,headers:{
        ...(body!==undefined?{'Content-Type':'application/json'}:{}),
        ...(method!=='GET'?{'X-Talaeats-Client':'core-v2-lab'}:{}),
        ...(cookie?{Cookie:cookie}:{}),...extra
      },body:body===undefined?undefined:JSON.stringify(body)
    });
    return {status:response.status,body:await response.json(),
      cache:response.headers.get('cache-control'),setCookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  return {base,request,close:()=>new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()))};
}
async function register(request){
  const email='c-'+randomUUID()+'@example.test',password='Strong-Pass-2026!';
  const response=await request('POST','/api/v2/auth/register',{
    email,password,displayName:'Comprador de pruebas'
  });
  assert.equal(response.status,201);
  const login=await request('POST','/api/v2/auth/login',{email,password});
  assert.equal(login.status,200);
  return {id:response.body.id,cookie:login.setCookie};
}
async function merchant(pool,request,storeId){
  const email='merchant-'+randomUUID()+'@example.test',password='Merchant-Strong-Pass-2026!';
  const result=await pool.query(`
    INSERT INTO tala_core_v2.accounts(email,display_name,password_hash,role)
    VALUES($1,'Comercio Prueba',$2,'merchant') RETURNING id`,[email,await hashPassword(password)]);
  const id=result.rows[0].id;
  if(storeId)await pool.query(`
    INSERT INTO tala_core_v2.restaurant_memberships(restaurant_id,member_id,is_active)
    VALUES($1::uuid,$2::uuid,true)`,[storeId,id]);
  const logged=await request('POST','/api/v2/auth/login',{email,password});
  assert.equal(logged.status,200);
  return {id,cookie:logged.setCookie};
}
async function store(pool){
  const id=randomUUID(),product=randomUUID();
  await pool.query(`INSERT INTO tala_core_v2.restaurants(id,name,is_open) VALUES($1,'Restaurante QA',true)`,[id]);
  await pool.query(`INSERT INTO tala_core_v2.catalog_products(id,restaurant_id,name,price_minor,stock)
    VALUES($1,$2,'Producto pruebas',15000,4)`,[product,id]);
  return {id,product};
}

test('P0 lab: ownership, empty pickup address, no stale cache, batched reads and active-store gate',{
  skip:!enabled,timeout:40000
},async()=>{
  const pool=new Pool({connectionString:db,max:6});
  const api=await serve(pool);
  try{
    const shop=await store(pool);
    const buyer=await register(api.request),stranger=await register(api.request);
    const goodMerchant=await merchant(pool,api.request,shop.id);
    const otherMerchant=await merchant(pool,api.request,null);
    const input={restaurantId:shop.id,fulfillment:'pickup',
      lines:[{productId:shop.product,quantity:1}],
      deliveryAddress:'',paymentMethod:'cash',idempotencyKey:key()};
    const created=await api.request('POST','/api/v2/orders',input,buyer.cookie);
    assert.equal(created.status,201,JSON.stringify(created.body));
    assert.equal(created.cache,'no-store');
    const id=created.body.order.id;
    assert.equal(created.body.order.deliveryAddress,null);
    const strangerRead=await api.request('GET','/api/v2/orders/'+id,undefined,stranger.cookie);
    assert.equal(strangerRead.status,404);
    assert.equal((await api.request('GET','/api/v2/merchant/orders',undefined,otherMerchant.cookie)).body.length,0);
    const outsiderWrite=await api.request('PATCH','/api/v2/merchant/orders/'+id+'/status',
      {status:'confirmed',expectedVersion:'1',commandKey:key()},otherMerchant.cookie);
    assert.equal(outsiderWrite.status,404);
    const sameSite=await api.request('POST','/api/v2/orders',input,buyer.cookie,
      {'Sec-Fetch-Site':'cross-site'});
    assert.equal(sameSite.status,403);
    const origin=await api.request('POST','/api/v2/orders',input,buyer.cookie,
      {Origin:'https://another-site.example'});
    assert.equal(origin.status,403);
    const realMerchant=await api.request('GET','/api/v2/merchant/orders',undefined,goodMerchant.cookie);
    assert.equal(realMerchant.status,200);
    assert.equal(realMerchant.body.length>=1,true);
    let queryCount=0;
    const proxy={query:(...args)=>{queryCount++;return pool.query(...args);}};
    const orders=await listBuyerOrders(proxy,buyer.id);
    assert.equal(queryCount,2,'orders and all lines must load in exactly 2 SQL queries');
    assert.equal(orders.filter(o=>o.id===id).length,1);
    assert.equal(orders.find(o=>o.id===id).lines[0].name,'Producto pruebas');
    await pool.query('UPDATE tala_core_v2.restaurants SET is_open=false WHERE id=$1',[shop.id]);
    const menuClosed=await api.request('GET','/api/v2/restaurants/'+shop.id+'/menu');
    assert.equal(menuClosed.status,200);
    assert.deepEqual(menuClosed.body,[]);
    const closed=await api.request('POST','/api/v2/orders',{
      ...input,idempotencyKey:key()
    },buyer.cookie);
    assert.equal(closed.status,409);
    assert.equal(closed.body.code,'RESTAURANT_UNAVAILABLE');
    assert.equal((await pool.query(
      'SELECT stock FROM tala_core_v2.catalog_products WHERE id=$1',[shop.product]
    )).rows[0].stock,3);
  }finally{await api.close();await pool.end();}
});

test('P0 lab: concurrent merchant accept vs buyer cancel is serialized; never duplicates stock',{
  skip:!enabled,timeout:40000
},async()=>{
  const pool=new Pool({connectionString:db,max:6});
  const api=await serve(pool);
  try{
    const shop=await store(pool);
    const buyer=await register(api.request);
    const seller=await merchant(pool,api.request,shop.id);
    const created=await api.request('POST','/api/v2/orders',{
      restaurantId:shop.id,fulfillment:'pickup',lines:[{productId:shop.product,quantity:1}],
      paymentMethod:'cash',idempotencyKey:key()
    },buyer.cookie);
    assert.equal(created.status,201);
    const id=created.body.order.id;
    const [advanced,cancelled]=await Promise.all([
      api.request('PATCH','/api/v2/merchant/orders/'+id+'/status',{
        status:'confirmed',expectedVersion:'1',commandKey:key()
      },seller.cookie),
      api.request('POST','/api/v2/orders/'+id+'/cancel',{
        expectedVersion:'1',commandKey:key()
      },buyer.cookie)
    ]);
    assert.deepEqual([advanced.status,cancelled.status].sort(),[200,409]);
    const record=await pool.query('SELECT status,version FROM tala_core_v2.orders WHERE id=$1',[id]);
    const current=record.rows[0];
    assert.equal(current.version,'2');
    assert.ok(['confirmed','cancelled'].includes(current.status));
    const stock=await pool.query('SELECT stock FROM tala_core_v2.catalog_products WHERE id=$1',[shop.product]);
    assert.equal(stock.rows[0].stock,current.status==='cancelled'?4:3);
    const event=await pool.query(`
      SELECT count(*)::int AS n FROM tala_core_v2.order_events WHERE order_id=$1`,[id]);
    const outbox=await pool.query(`
      SELECT count(*)::int AS n FROM tala_core_v2.outbox WHERE aggregate_id=$1`,[id]);
    assert.equal(event.rows[0].n,2);
    assert.equal(outbox.rows[0].n,2);
  }finally{await api.close();await pool.end();}
});

test('P0 lab: incorrect credentials respond 401, bounded login attempts respond 429',{
  skip:!enabled,timeout:15000
},async()=>{
  const pool=new Pool({connectionString:db,max:2});
  const api=await serve(pool);
  try{
    for(let n=0;n<12;n++){
      const wrong=await api.request('POST','/api/v2/auth/login',{
        email:'missing-'+randomUUID()+'@example.test',password:'invalid'
      });
      assert.equal(wrong.status,401);
      assert.equal(wrong.body.code,'INVALID_CREDENTIALS');
    }
    const blocked=await api.request('POST','/api/v2/auth/login',{
      email:'missing-'+randomUUID()+'@example.test',password:'invalid'
    });
    assert.equal(blocked.status,429);
    assert.equal(blocked.body.code,'AUTH_RATE_LIMITED');
  }finally{await api.close();await pool.end();}
});

test('P0 lab: malformed JSON is 400, oversized body 413, lock timeout 503 and safe same-key retry',{
  skip:!enabled,timeout:45000
},async()=>{
  const pool=new Pool({connectionString:db,max:5});
  const api=await serve(pool);
  let locker;
  try{
    const shop=await store(pool);
    const buyer=await register(api.request);
    const headers={'Content-Type':'application/json','X-Talaeats-Client':'core-v2-lab'};
    const broken=await fetch(api.base+'/api/v2/auth/login',{
      method:'POST',headers,body:'{"email":'
    });
    assert.equal(broken.status,400);
    assert.deepEqual(await broken.json(),{code:'REQUEST_INVALID'});
    const oversized=await fetch(api.base+'/api/v2/auth/login',{
      method:'POST',headers,body:JSON.stringify({junk:'x'.repeat(22000)})
    });
    assert.equal(oversized.status,413);
    assert.deepEqual(await oversized.json(),{code:'BODY_TOO_LARGE'});
    const checkout={restaurantId:shop.id,fulfillment:'pickup',
      lines:[{productId:shop.product,quantity:1}],
      paymentMethod:'cash',idempotencyKey:key()};
    locker=await pool.connect();
    await locker.query('BEGIN');
    await locker.query('UPDATE tala_core_v2.restaurants SET is_open=true WHERE id=$1',[shop.id]);
    // Checkout waits for the restaurant row's FOR SHARE lock.
    const retryLater=await api.request('POST','/api/v2/orders',checkout,buyer.cookie);
    assert.equal(retryLater.status,503,JSON.stringify(retryLater.body));
    assert.equal(retryLater.body.code,'ORDER_TEMPORARILY_BUSY');
    await locker.query('ROLLBACK');
    locker.release();locker=null;
    const recovered=await api.request('POST','/api/v2/orders',checkout,buyer.cookie);
    assert.equal(recovered.status,201,JSON.stringify(recovered.body));
    const replay=await api.request('POST','/api/v2/orders',checkout,buyer.cookie);
    assert.equal(replay.status,200);
    assert.equal(replay.body.replayed,true);
    const check=await pool.query('SELECT stock FROM tala_core_v2.catalog_products WHERE id=$1',[shop.product]);
    assert.equal(check.rows[0].stock,3);
  }finally{
    if(locker){await locker.query('ROLLBACK');locker.release();}
    await api.close();await pool.end();
  }
});

test('P0: uppercase UUID cart is equivalent to lowercase for quote, checkout and replay',{
  skip:!enabled,timeout:25000
},async()=>{
  const pool=new Pool({connectionString:db,max:4});
  const api=await serve(pool);
  try{
    const shop=await store(pool);
    const buyer=await register(api.request);
    const input={restaurantId:shop.id.toUpperCase(),fulfillment:'pickup',
      lines:[{productId:shop.product.toUpperCase(),quantity:1}],
      paymentMethod:'cash',idempotencyKey:key()};
    const quote=await api.request('POST','/api/v2/orders/quote',{
      restaurantId:input.restaurantId,fulfillment:'pickup',lines:input.lines
    },buyer.cookie);
    assert.equal(quote.status,200,JSON.stringify(quote.body));
    const first=await api.request('POST','/api/v2/orders',input,buyer.cookie);
    assert.equal(first.status,201,JSON.stringify(first.body));
    assert.equal(first.body.order.lines[0].name,'Producto pruebas');
    const replay=await api.request('POST','/api/v2/orders',{
      ...input,restaurantId:shop.id,
      lines:[{productId:shop.product,quantity:1}]
    },buyer.cookie);
    assert.equal(replay.status,200,JSON.stringify(replay.body));
    assert.equal(replay.body.replayed,true);
    assert.equal(replay.body.order.id,first.body.order.id);
    const duplicate=await api.request('POST','/api/v2/orders',{
      ...input,idempotencyKey:key(),lines:[
        {productId:shop.product,quantity:1},
        {productId:shop.product.toUpperCase(),quantity:1}
      ]
    },buyer.cookie);
    assert.equal(duplicate.status,400);
    assert.equal(duplicate.body.code,'CART_INVALID');
    const remaining=await pool.query(
      'SELECT stock FROM tala_core_v2.catalog_products WHERE id=$1',[shop.product]);
    assert.equal(remaining.rows[0].stock,3);
  }finally{await api.close();await pool.end();}
});

test('P0: cancellation policy matches machine after merchant confirmation',{
  skip:!enabled,timeout:25000
},async()=>{
  const pool=new Pool({connectionString:db,max:4});
  const api=await serve(pool);
  try{
    const shop=await store(pool);
    const buyer=await register(api.request);
    const seller=await merchant(pool,api.request,shop.id);
    const input={restaurantId:shop.id,fulfillment:'pickup',
      lines:[{productId:shop.product,quantity:1}],
      paymentMethod:'cash',idempotencyKey:key()};
    const created=await api.request('POST','/api/v2/orders',input,buyer.cookie);
    assert.equal(created.status,201);
    const id=created.body.order.id;
    const confirm=await api.request('PATCH','/api/v2/merchant/orders/'+id+'/status',{
      status:'confirmed',expectedVersion:'1',commandKey:key()
    },seller.cookie);
    assert.equal(confirm.status,200,JSON.stringify(confirm.body));
    const buyerCannot=await api.request('POST','/api/v2/orders/'+id+'/cancel',{
      expectedVersion:'2',commandKey:key()
    },buyer.cookie);
    assert.equal(buyerCannot.status,409);
    assert.equal(buyerCannot.body.code,'CANCELLATION_NOT_ALLOWED');
    const cancelBody={expectedVersion:'2',commandKey:key()};
    const cancel=await api.request('POST','/api/v2/merchant/orders/'+id+'/cancel',
      cancelBody,seller.cookie);
    assert.equal(cancel.status,200,JSON.stringify(cancel.body));
    assert.equal(cancel.body.status,'cancelled');
    const replay=await api.request('POST','/api/v2/merchant/orders/'+id.toUpperCase()+'/cancel',
      cancelBody,seller.cookie);
    assert.equal(replay.status,200);
    assert.equal(replay.body.replayed,true);
    const stock=await pool.query('SELECT stock FROM tala_core_v2.catalog_products WHERE id=$1',
      [shop.product]);
    assert.equal(stock.rows[0].stock,4);
    const evidence=await pool.query('SELECT COUNT(*)::int AS n FROM tala_core_v2.order_events WHERE order_id=$1',[id]);
    assert.equal(evidence.rows[0].n,3);
  }finally{await api.close();await pool.end();}
});

test('P0: oversized cart total rejects quote and checkout without stock mutation',{
  skip:!enabled,timeout:20000
},async()=>{
  const pool=new Pool({connectionString:db,max:4});
  const api=await serve(pool);
  try{
    const shop=await store(pool);
    const buyer=await register(api.request);
    await pool.query(`
      UPDATE tala_core_v2.catalog_products SET price_minor=1000000000,stock=101
      WHERE id=$1::uuid`,[shop.product]);
    const cart={restaurantId:shop.id,fulfillment:'pickup',
      lines:[{productId:shop.product,quantity:100}]};
    const quote=await api.request('POST','/api/v2/orders/quote',cart,buyer.cookie);
    assert.equal(quote.status,400,JSON.stringify(quote.body));
    assert.equal(quote.body.code,'CART_TOTAL_OUT_OF_RANGE');
    const checkout=await api.request('POST','/api/v2/orders',{
      ...cart,paymentMethod:'cash',idempotencyKey:key()
    },buyer.cookie);
    assert.equal(checkout.status,400,JSON.stringify(checkout.body));
    assert.equal(checkout.body.code,'CART_TOTAL_OUT_OF_RANGE');
    const state=await pool.query(`
      SELECT p.stock,(SELECT count(*)::int FROM tala_core_v2.orders
        WHERE restaurant_id=$2::uuid) AS orders
      FROM tala_core_v2.catalog_products p WHERE p.id=$1::uuid`,
      [shop.product,shop.id]);
    assert.equal(state.rows[0].stock,101);
    assert.equal(state.rows[0].orders,0);
  }finally{await api.close();await pool.end();}
});

test('P0 stress: parallel buyers cannot oversell or write orphan order events',{
  skip:!enabled,timeout:60000
},async()=>{
  const pool=new Pool({connectionString:db,max:12});
  const api=await serve(pool);
  try{
    const shop=await store(pool); // 4 units of one product.
    const buyers=await Promise.all(Array.from({length:6},()=>register(api.request)));
    const inputs=buyers.map(()=>({
      restaurantId:shop.id,fulfillment:'pickup',
      lines:[{productId:shop.product,quantity:1}],
      paymentMethod:'cash',idempotencyKey:key()
    }));
    const results=await Promise.all(buyers.map(async(buyer,index)=>{
      let result;
      for(let retry=0;retry<3;retry++){
        result=await api.request('POST','/api/v2/orders',inputs[index],buyer.cookie);
        if(result.status!==503)break;
      }
      return result;
    }));
    const errors=results.filter(x=>x.status!==201&&
      !(x.status===409&&x.body.code==='OUT_OF_STOCK'));
    assert.deepEqual(errors.map(x=>({status:x.status,code:x.body.code})),[],
      'No HTTP 500, duplicates or unexpected concurrency errors');
    assert.equal(results.filter(x=>x.status===201).length,4);
    assert.equal(results.filter(x=>x.status===409).length,2);
    const stock=await pool.query(
      'SELECT stock FROM tala_core_v2.catalog_products WHERE id=$1',[shop.product]);
    assert.equal(stock.rows[0].stock,0);
    const evidence=await pool.query(`
      SELECT COUNT(*)::int AS orders,
        (SELECT COUNT(*)::int FROM tala_core_v2.order_events e
          JOIN tala_core_v2.orders o ON o.id=e.order_id
          WHERE o.restaurant_id=$1::uuid) AS events,
        (SELECT COUNT(*)::int FROM tala_core_v2.outbox b
          JOIN tala_core_v2.orders o ON o.id=b.aggregate_id
          WHERE o.restaurant_id=$1::uuid) AS outbox,
        (SELECT SUM(total_minor)::text FROM tala_core_v2.orders
          WHERE restaurant_id=$1::uuid) AS total
      FROM tala_core_v2.orders WHERE restaurant_id=$1::uuid`,[shop.id]);
    assert.equal(evidence.rows[0].orders,4);
    assert.equal(evidence.rows[0].events,4);
    assert.equal(evidence.rows[0].outbox,4);
    assert.equal(evidence.rows[0].total,'64200');
  }finally{await api.close();await pool.end();}
});
