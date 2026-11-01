import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createOrderApp} from '../src/modules/orders/lab-http.ts';
import {hashPassword} from '../src/modules/orders/lab-auth.ts';

const db=process.env.PG_CI_URL||'';
const enabled=db.includes('/tala_core_v2_test');
const key=()=> 'cmd-'+randomUUID();
const line=(productId,quantity=1)=>({productId,quantity});
const setup=async(pool)=>{
  const restaurant=randomUUID(),product=randomUUID(),merchant=randomUUID();
  await pool.query(`INSERT INTO tala_core_v2.restaurants(id,name,is_open)
    VALUES($1::uuid,'Comida de laboratorio',true)`,[restaurant]);
  await pool.query(`INSERT INTO tala_core_v2.catalog_products(id,restaurant_id,name,price_minor,stock)
    VALUES($1::uuid,$2::uuid,'Torta de prueba',10000,5)`,[product,restaurant]);
  await pool.query(`INSERT INTO tala_core_v2.accounts(id,email,display_name,password_hash,role)
    VALUES($1::uuid,$2,'Operador autorizado',$3,'merchant')`,
    [merchant,'m-'+randomUUID()+'@example.test',await hashPassword('Merchant-StrongPass-2026!')]);
  await pool.query(`INSERT INTO tala_core_v2.restaurant_memberships(restaurant_id,member_id,is_active)
    VALUES($1::uuid,$2::uuid,true)`,[restaurant,merchant]);
  const mail=(await pool.query('SELECT email FROM tala_core_v2.accounts WHERE id=$1',[merchant])).rows[0].email;
  return {restaurant,product,merchant,merchantEmail:mail};
};
test('HTTP LAB: buyer → catálogo → checkout → restaurante → cocina → cancelación con stock',{
  skip:!enabled,timeout:40000
},async()=>{
  const pool=new Pool({connectionString:db,max:6});
  const app=createOrderApp(pool);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const address=server.address();
  assert.equal(typeof address,'object');
  const url='http://127.0.0.1:'+address.port;
  const request=async(method,path,body,cookie)=>{
    const response=await fetch(url+path,{
      method,headers:{
        ...(body!==undefined?{'Content-Type':'application/json'}:{}),
        ...(method!=='GET'?{'X-Talaeats-Client':'core-v2-lab'}:{}),
        ...(cookie?{Cookie:cookie}:{})
      },body:body===undefined?undefined:JSON.stringify(body)
    });
    const data=await response.json();
    return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  try{
    const {restaurant,product,merchantEmail}=await setup(pool);
    const userEmail='buyer-'+randomUUID()+'@example.test';
    const registered=await request('POST','/api/v2/auth/register',{
      email:userEmail,displayName:'Comprador laboratorio',password:'Buyer-StrongPass-2026!'
    });
    assert.equal(registered.status,201);
    assert.equal(registered.data.role,'customer');
    const injection=await request('POST','/api/v2/auth/register',{
      email:'admin-'+randomUUID()+'@example.test',
      displayName:'Administrador falso',password:'Buyer-StrongPass-2026!',role:'merchant'
    });
    assert.equal(injection.status,400);
    const buyerLogin=await request('POST','/api/v2/auth/login',{
      email:userEmail,password:'Buyer-StrongPass-2026!'
    });
    assert.equal(buyerLogin.status,200);
    const buyerCookie=buyerLogin.cookie;
    assert.match(buyerCookie,/^core_v2_session=/);
    const merchantLogin=await request('POST','/api/v2/auth/login',{
      email:merchantEmail,password:'Merchant-StrongPass-2026!'
    });
    assert.equal(merchantLogin.status,200);
    const merchantCookie=merchantLogin.cookie;
    const me=await request('GET','/api/v2/auth/me',undefined,buyerCookie);
    assert.equal(me.data.role,'customer');
    const forbiddenMerchant=await request('GET','/api/v2/merchant/orders',undefined,buyerCookie);
    assert.equal(forbiddenMerchant.status,403);

    const base={restaurantId:restaurant,fulfillment:'pickup',lines:[line(product,2)]};
    const quote=await request('POST','/api/v2/orders/quote',base,buyerCookie);
    assert.equal(quote.status,200);
    assert.equal(quote.data.totalMinor,'21400');
    assert.equal(quote.data.merchantCommissionMinor,'3400');
    assert.equal(quote.data.serviceFeeMinor,'1400');
    const checkout={...base,paymentMethod:'cash',idempotencyKey:key()};
    const created=await request('POST','/api/v2/orders',checkout,buyerCookie);
    assert.equal(created.status,201);
    assert.equal(created.data.order.status,'received');
    assert.equal(created.data.order.totalMinor,'21400');
    const orderId=created.data.order.id;
    const replay=await request('POST','/api/v2/orders',checkout,buyerCookie);
    assert.equal(replay.status,200);
    assert.equal(replay.data.replayed,true);
    assert.equal(replay.data.order.id,orderId);
    const clash=await request('POST','/api/v2/orders',{
      ...checkout,lines:[line(product,1)]
    },buyerCookie);
    assert.equal(clash.status,409);
    assert.equal(clash.data.code,'IDEMPOTENCY_CONFLICT');

    const stock=await pool.query('SELECT stock FROM tala_core_v2.catalog_products WHERE id=$1',[product]);
    assert.equal(stock.rows[0].stock,3);
    const merchantOrders=await request('GET','/api/v2/merchant/orders',undefined,merchantCookie);
    assert.equal(merchantOrders.status,200);
    assert.equal(merchantOrders.data.filter(o=>o.id===orderId).length,1);
    let version='1';
    for(const status of ['confirmed','preparing','ready']){
      const response=await request('PATCH','/api/v2/merchant/orders/'+orderId+'/status',{
        status,commandKey:key(),expectedVersion:version
      },merchantCookie);
      assert.equal(response.status,200,JSON.stringify(response.data));
      assert.equal(response.data.status,status);
      version=response.data.version;
    }
    assert.equal(version,'4');
    const illegal=await request('POST','/api/v2/orders/'+orderId+'/cancel',{
      commandKey:key(),expectedVersion:version
    },buyerCookie);
    assert.equal(illegal.status,409);
    assert.equal(illegal.data.code,'CANCELLATION_NOT_ALLOWED');
    const details=await request('GET','/api/v2/orders/'+orderId,undefined,buyerCookie);
    assert.equal(details.status,200);
    assert.equal(details.data.status,'ready');
    assert.equal(details.data.lines[0].name,'Torta de prueba');

    const second=await request('POST','/api/v2/orders',{
      ...base,lines:[line(product,1)],paymentMethod:'cash',idempotencyKey:key()
    },buyerCookie);
    assert.equal(second.status,201);
    const cancelBody={commandKey:key(),expectedVersion:'1'};
    const cancel=await request('POST','/api/v2/orders/'+second.data.order.id+'/cancel',
      cancelBody,buyerCookie);
    assert.equal(cancel.status,200);
    assert.equal(cancel.data.status,'cancelled');
    const cancelAgain=await request('POST','/api/v2/orders/'+second.data.order.id+'/cancel',
      cancelBody,buyerCookie);
    assert.equal(cancelAgain.status,200);
    assert.equal(cancelAgain.data.replayed,true);
    const end=await pool.query('SELECT stock FROM tala_core_v2.catalog_products WHERE id=$1',[product]);
    assert.equal(end.rows[0].stock,3);

    const evidence=await pool.query(`
      SELECT (SELECT COUNT(*)::int FROM tala_core_v2.order_events WHERE order_id=$1) events,
       (SELECT COUNT(*)::int FROM tala_core_v2.outbox WHERE aggregate_id=$1) outbox`,
      [orderId]);
    assert.deepEqual(evidence.rows[0],{events:4,outbox:4});
    const logout=await request('POST','/api/v2/auth/logout',{},buyerCookie);
    assert.equal(logout.status,200);
    const afterward=await request('GET','/api/v2/orders/mine',undefined,buyerCookie);
    assert.equal(afterward.status,401);
  }finally{
    await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
    await pool.end();
  }
});

test('HTTP LAB: venta concurrente no sobregira inventario y no acepta pagos Stripe desde cliente',{
  skip:!enabled,timeout:30000
},async()=>{
  const pool=new Pool({connectionString:db,max:5});
  const app=createOrderApp(pool);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const url='http://127.0.0.1:'+address.port;
  const request=async(method,path,data,cookie)=>{
    const response=await fetch(url+path,{method,headers:{
      'Content-Type':'application/json','X-Talaeats-Client':'core-v2-lab',
      ...(cookie?{Cookie:cookie}:{})
    },body:JSON.stringify(data)});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  try{
    const {restaurant,product}=await setup(pool);
    await pool.query('UPDATE tala_core_v2.catalog_products SET stock=1 WHERE id=$1',[product]);
    const mail='buyer-'+randomUUID()+'@example.test';
    assert.equal((await request('POST','/api/v2/auth/register',{
      email:mail,displayName:'Comprador concurrente',password:'Buyer-StrongPass-2026!'
    })).status,201);
    const auth=(await request('POST','/api/v2/auth/login',{
      email:mail,password:'Buyer-StrongPass-2026!'
    })).cookie;
    const base={restaurantId:restaurant,fulfillment:'pickup',lines:[line(product)],
      paymentMethod:'cash'};
    const [a,b]=await Promise.all([
      request('POST','/api/v2/orders',{...base,idempotencyKey:key()},auth),
      request('POST','/api/v2/orders',{...base,idempotencyKey:key()},auth)
    ]);
    assert.deepEqual([a.status,b.status].sort(),[201,409]);
    const count=await pool.query(`
      SELECT COUNT(*)::int AS total FROM tala_core_v2.orders WHERE restaurant_id=$1`,[restaurant]);
    assert.equal(count.rows[0].total,1);
    const stripe=await request('POST','/api/v2/orders',{
      ...base,paymentMethod:'stripe',idempotencyKey:key()
    },auth);
    assert.equal(stripe.status,400);
    const fakePrice=await request('POST','/api/v2/orders',{
      ...base,idempotencyKey:key(),totalMinor:'1'
    },auth);
    assert.equal(fakePrice.status,400);
  }finally{
    await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
    await pool.end();
  }
});
