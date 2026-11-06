import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createOrderApp} from '../src/modules/orders/lab-http.ts';
import {hashPassword} from '../src/modules/orders/lab-auth.ts';

const url=process.env.PG_CI_URL??'';
const enabled=url.includes('/tala_core_v2_test');
const password='Orders-Read-P0-2026!';
const key=()=> 'orders-read-'+randomUUID();

async function fixture(){
  const pool=new Pool({connectionString:url,max:6});
  const app=createOrderApp(pool);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const port=server.address().port;
  const request=async(method,path,body,cookie)=>{
    const response=await fetch('http://127.0.0.1:'+port+path,{
      method,headers:{
        ...(body!==undefined?{'Content-Type':'application/json'}:{}),
        ...(method!=='GET'?{'X-Talaeats-Client':'core-v2-lab'}:{}),
        ...(cookie?{Cookie:cookie}:{})
      },body:body===undefined?undefined:JSON.stringify(body)
    });
    return {status:response.status,body:await response.json(),
      cookie:response.headers.get('set-cookie')?.split(';')[0],
      cache:response.headers.get('cache-control')};
  };
  const createAccount=async(role,storeId)=>{
    const id=randomUUID(),email=role+'-'+randomUUID()+'@example.test';
    await pool.query(`
      INSERT INTO tala_core_v2.accounts(id,email,display_name,password_hash,role)
      VALUES($1::uuid,$2,'Test Orders Read',$3,$4)`,
      [id,email,await hashPassword(password),role]);
    if(role==='merchant'&&storeId){
      await pool.query(`
        INSERT INTO tala_core_v2.restaurant_memberships(restaurant_id,member_id,is_active)
        VALUES($1::uuid,$2::uuid,true)`,[storeId,id]);
    }
    if(role==='driver'){
      await pool.query(`
        INSERT INTO tala_core_v2.driver_profiles(account_id,approved,is_online)
        VALUES($1::uuid,true,true)`,[id]);
    }
    const login=await request('POST','/api/v2/auth/login',{email,password});
    assert.equal(login.status,200,JSON.stringify(login.body));
    return {id,cookie:login.cookie};
  };
  const createStore=async()=>{
    const store=randomUUID(),product=randomUUID();
    await pool.query(`
      INSERT INTO tala_core_v2.restaurants(id,name,is_open)
      VALUES($1::uuid,'Restaurante seguimiento',true)`,[store]);
    await pool.query(`
      INSERT INTO tala_core_v2.catalog_products(id,restaurant_id,name,price_minor,stock)
      VALUES($1::uuid,$2::uuid,'Pedido de seguimiento',15000,9)`,[product,store]);
    return {store,product};
  };
  const createOrder=async(buyer,store,product,fulfillment='pickup')=>{
    const result=await request('POST','/api/v2/orders',{
      restaurantId:store,fulfillment,lines:[{productId:product,quantity:2}],
      paymentMethod:'cash',idempotencyKey:key(),
      ...(fulfillment==='delivery'?{deliveryAddress:'Calle QA 456, Tala'}:{})
    },buyer.cookie);
    assert.equal(result.status,201,JSON.stringify(result.body));
    return result.body.order;
  };
  const close=async()=>{
    await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
    await pool.end();
  };
  return {pool,request,createAccount,createStore,createOrder,close};
}
const transitions=history=>history.map(x=>x.to);

test('P0 read: buyer receipt is immutable, exact and never exposes platform margins',{
  skip:!enabled,timeout:40000
},async()=>{
  const f=await fixture();
  try{
    const shop=await f.createStore();
    const buyer=await f.createAccount('customer');
    const stranger=await f.createAccount('customer');
    const merchant=await f.createAccount('merchant',shop.store);
    const outsider=await f.createAccount('merchant');
    const order=await f.createOrder(buyer,shop.store,shop.product,'pickup');
    const id=order.id;
    const receipt=await f.request('GET','/api/v2/orders/'+id+'/receipt',undefined,buyer.cookie);
    assert.equal(receipt.status,200,JSON.stringify(receipt.body));
    assert.equal(receipt.cache,'no-store');
    assert.deepEqual(receipt.body,{
      orderId:id,status:'received',paymentMethod:'cash',paymentStatus:'pending',
      currency:'MXN',fulfillment:'pickup',itemsMinor:'30000',
      serviceFeeMinor:'2100',deliveryFeeMinor:'0',tipMinor:'0',
      totalMinor:'32100',lines:[{
        name:'Pedido de seguimiento',quantity:2,unitMinor:'15000',
        lineTotalMinor:'30000'
      }]
    });
    const printed=JSON.stringify(receipt.body);
    for(const privateKey of ['merchantCommissionMinor','merchantPayableMinor',
      'platformGrossMinor','driverPayableMinor','price_snapshot','request_hash']){
      assert.equal(printed.includes(privateKey),false,privateKey);
    }
    // Once purchased, even a drastic catalog price change cannot alter
    // a buyer's receipt or the immutable amount they owe.
    await f.pool.query(
      'UPDATE tala_core_v2.catalog_products SET price_minor=27000 WHERE id=$1::uuid',
      [shop.product]
    );
    const stillOriginal=await f.request('GET','/api/v2/orders/'+id+'/receipt',undefined,buyer.cookie);
    assert.equal(stillOriginal.status,200);
    assert.deepEqual(stillOriginal.body,receipt.body);
    assert.equal((await f.request('GET','/api/v2/orders/'+id+'/receipt',undefined,stranger.cookie)).status,404);
    assert.equal((await f.request('GET','/api/v2/orders/'+id+'/receipt',undefined,merchant.cookie)).status,403);
    assert.equal((await f.request('GET','/api/v2/merchant/orders/'+id,undefined,outsider.cookie)).status,404);
    const merchantDetail=await f.request('GET','/api/v2/merchant/orders/'+id,undefined,merchant.cookie);
    assert.equal(merchantDetail.status,200,JSON.stringify(merchantDetail.body));
    assert.equal(merchantDetail.body.id,id);
    assert.equal(merchantDetail.body.version,'1');
    assert.equal(merchantDetail.body.lines[0].name,'Pedido de seguimiento');
    assert.equal(merchantDetail.body.buyerId,buyer.id);
    const timeline=await f.request('GET','/api/v2/orders/'+id+'/timeline',undefined,buyer.cookie);
    assert.equal(timeline.status,200);
    assert.equal(timeline.body.status,'received');
    assert.deepEqual(transitions(timeline.body.history),['received']);
    assert.equal(timeline.body.history[0].from,null);
    assert.ok(timeline.body.history[0].occurredAt);
  }finally{await f.close();}
});

test('P0 read: history only shows real transitions, hides PIN and cash event payloads',{
  skip:!enabled,timeout:40000
},async()=>{
  const f=await fixture();
  try{
    const shop=await f.createStore();
    const buyer=await f.createAccount('customer');
    const wrongBuyer=await f.createAccount('customer');
    const merchant=await f.createAccount('merchant',shop.store);
    const otherMerchant=await f.createAccount('merchant');
    const driver=await f.createAccount('driver');
    const order=await f.createOrder(buyer,shop.store,shop.product);
    const id=order.id;
    let version='1';
    for(const status of ['confirmed','preparing','ready']){
      const response=await f.request('PATCH','/api/v2/merchant/orders/'+id+'/status',
        {status,expectedVersion:version,commandKey:key()},merchant.cookie);
      assert.equal(response.status,200,JSON.stringify(response.body));
      version=response.body.version;
    }
    const initial=await f.request('GET','/api/v2/orders/'+id+'/timeline',undefined,buyer.cookie);
    assert.equal(initial.status,200);
    assert.equal(initial.body.status,'ready');
    assert.equal(initial.body.version,'4');
    assert.deepEqual(transitions(initial.body.history),['received','confirmed','preparing','ready']);
    assert.equal((await f.request('GET','/api/v2/orders/'+id+'/timeline',undefined,wrongBuyer.cookie)).status,404);
    assert.equal((await f.request('GET','/api/v2/merchant/orders/'+id+'/timeline',undefined,otherMerchant.cookie)).status,404);
    assert.equal((await f.request('GET','/api/v2/driver/orders/'+id+'/timeline',undefined,driver.cookie)).status,404);
    const pin=await f.request('POST','/api/v2/orders/'+id+'/handoff-pin',{},buyer.cookie);
    assert.equal(pin.status,200);
    const buyerCash=await f.request('POST','/api/v2/orders/'+id+'/cash-paid',{},buyer.cookie);
    const merchantCash=await f.request('POST','/api/v2/merchant/orders/'+id+'/cash-received',{},merchant.cookie);
    assert.equal(buyerCash.status,200);
    assert.equal(merchantCash.status,200);
    const before=await f.request('GET','/api/v2/merchant/orders/'+id+'/timeline',undefined,merchant.cookie);
    assert.equal(before.status,200);
    assert.deepEqual(transitions(before.body.history),transitions(initial.body.history));
    assert.equal(JSON.stringify(before.body).includes(pin.body.pin),false,'never disclose PIN');
    for(const text of ['actor_id','actorId','event_key','data','cashAmountMinor','pin_hash','idempotencyKey'])
      assert.equal(JSON.stringify(before.body).includes('"'+text+'"'),false,text);
    const delivered=await f.request('POST','/api/v2/merchant/orders/'+id+'/complete',{
      pin:pin.body.pin,expectedVersion:'4',commandKey:key()
    },merchant.cookie);
    assert.equal(delivered.status,200,JSON.stringify(delivered.body));
    const done=await f.request('GET','/api/v2/orders/'+id+'/timeline',undefined,buyer.cookie);
    assert.equal(done.status,200);
    assert.equal(done.body.status,'delivered');
    assert.equal(done.body.version,'5');
    assert.deepEqual(transitions(done.body.history),['received','confirmed','preparing','ready','delivered']);
    const receipt=await f.request('GET','/api/v2/orders/'+id+'/receipt',undefined,buyer.cookie);
    assert.equal(receipt.status,200);
    assert.equal(receipt.body.paymentStatus,'paid');
    assert.equal(receipt.body.totalMinor,'32100');
    const afterSQL=await f.pool.query(
      'SELECT count(*)::int AS n FROM tala_core_v2.order_events WHERE order_id=$1',[id]);
    assert.ok(afterSQL.rows[0].n>done.body.history.length,'private audit events are excluded');
  }finally{await f.close();}
});

test('P0 read: driver sees timeline only after assignment and only while approved',{
  skip:!enabled,timeout:40000
},async()=>{
  const f=await fixture();
  try{
    const shop=await f.createStore();
    const buyer=await f.createAccount('customer');
    const merchant=await f.createAccount('merchant',shop.store);
    const assigned=await f.createAccount('driver'),other=await f.createAccount('driver');
    const order=await f.createOrder(buyer,shop.store,shop.product,'delivery');
    let version='1';
    for(const status of ['confirmed','preparing','ready']){
      const r=await f.request('PATCH','/api/v2/merchant/orders/'+order.id+'/status',{
        status,expectedVersion:version,commandKey:key()
      },merchant.cookie);
      assert.equal(r.status,200,JSON.stringify(r.body));
      version=r.body.version;
    }
    assert.equal((await f.request('GET','/api/v2/driver/orders/'+order.id+'/timeline',undefined,assigned.cookie)).status,404);
    const claim=await f.request('POST','/api/v2/driver/orders/'+order.id+'/claim',{
      expectedVersion:version,commandKey:key()
    },assigned.cookie);
    assert.equal(claim.status,200,JSON.stringify(claim.body));
    const timeline=await f.request('GET','/api/v2/driver/orders/'+order.id+'/timeline',undefined,assigned.cookie);
    assert.equal(timeline.status,200);
    assert.deepEqual(transitions(timeline.body.history),['received','confirmed','preparing','ready','assigned']);
    assert.equal(JSON.stringify(timeline.body).includes('Calle QA 456'),false);
    assert.equal((await f.request('GET','/api/v2/driver/orders/'+order.id+'/timeline',undefined,other.cookie)).status,404);
    await f.pool.query('UPDATE tala_core_v2.driver_profiles SET approved=false WHERE account_id=$1',[assigned.id]);
    assert.equal((await f.request('GET','/api/v2/driver/orders/'+order.id+'/timeline',undefined,assigned.cookie)).status,404);
  }finally{await f.close();}
});

test('P0 read: legacy incomplete snapshot gets safe error, not a fabricated receipt',{
  skip:!enabled,timeout:20000
},async()=>{
  const f=await fixture();
  try{
    const buyer=await f.createAccount('customer'),shop=await f.createStore();
    const id=randomUUID();
    await f.pool.query(`
      INSERT INTO tala_core_v2.orders(id,buyer_id,restaurant_id,fulfillment,status,
        payment_method,payment_status,total_minor,pricing_policy_version,price_snapshot,
        idempotency_key,request_hash)
      VALUES($1::uuid,$2::uuid,$3::uuid,'pickup','received','cash','pending',
        10000,'lab-legacy','{}'::jsonb,$4,$5)`,
      [id,buyer.id,shop.store,key(),'a'.repeat(64)]);
    const response=await f.request('GET','/api/v2/orders/'+id+'/receipt',undefined,buyer.cookie);
    assert.equal(response.status,409);
    assert.equal(response.body.code,'RECEIPT_UNAVAILABLE');
  }finally{await f.close();}
});

test('P0 read: delivery receipt shows service and shipment, never driver payout',{
  skip:!enabled,timeout:20000
},async()=>{
  const f=await fixture();
  try{
    const shop=await f.createStore();
    const buyer=await f.createAccount('customer');
    const order=await f.createOrder(buyer,shop.store,shop.product,'delivery');
    const result=await f.request('GET','/api/v2/orders/'+order.id+'/receipt',undefined,buyer.cookie);
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(result.body.itemsMinor,'30000');
    assert.equal(result.body.serviceFeeMinor,'2100');
    assert.equal(result.body.deliveryFeeMinor,'3900');
    assert.equal(result.body.tipMinor,'0');
    assert.equal(result.body.totalMinor,'36000');
    const raw=JSON.stringify(result.body);
    assert.equal(raw.includes('driverPayableMinor'),false);
    assert.equal(raw.includes('merchantCommissionMinor'),false);
    assert.equal(raw.includes('Calle QA 456'),false);
  }finally{await f.close();}
});

test('P0 read: merchant detail can load an old order outside first 100 list',{
  skip:!enabled,timeout:20000
},async()=>{
  const f=await fixture();
  try{
    const shop=await f.createStore();
    const merchant=await f.createAccount('merchant',shop.store);
    const buyer=await f.createAccount('customer');
    const old=await f.createOrder(buyer,shop.store,shop.product);
    await f.pool.query(`
      INSERT INTO tala_core_v2.orders(
        buyer_id,restaurant_id,fulfillment,status,payment_method,payment_status,
        total_minor,pricing_policy_version,price_snapshot,idempotency_key,
        request_hash,created_at)
      SELECT $1::uuid,$2::uuid,'pickup','received','cash','pending',100,
        'lab-index-test','{}'::jsonb,'older-list-' || gen_random_uuid()::text,
        repeat('b',64),now()+interval '1 hour'
      FROM generate_series(1,101)`,[buyer.id,shop.store]);
    const recent=await f.request('GET','/api/v2/merchant/orders',undefined,merchant.cookie);
    assert.equal(recent.status,200);
    assert.equal(recent.body.length,100);
    assert.equal(recent.body.some(x=>x.id===old.id),false);
    const detail=await f.request('GET','/api/v2/merchant/orders/'+old.id,undefined,merchant.cookie);
    assert.equal(detail.status,200);
    assert.equal(detail.body.id,old.id);
    assert.equal(detail.body.lines.length,1);
    assert.equal(detail.body.lines[0].quantity,2);
  }finally{await f.close();}
});
