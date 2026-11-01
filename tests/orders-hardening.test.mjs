import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createOrderApp} from '../src/modules/orders/lab-http.ts';
import {hashPassword} from '../src/modules/orders/lab-auth.ts';
import {listBuyerOrders} from '../src/modules/orders/checkout.ts';

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
  return {request,close:()=>new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()))};
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
