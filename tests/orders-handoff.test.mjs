import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createOrderApp} from '../src/modules/orders/lab-http.ts';
import {hashPassword} from '../src/modules/orders/lab-auth.ts';

const db=process.env.PG_CI_URL??'';
const isolated=db.includes('/tala_core_v2_test');
const key=()=> 'cmd-'+randomUUID();
const pass='LAB-Strong-Password-2026!';
async function start(){
  const pool=new Pool({connectionString:db,max:8});
  const server=createOrderApp(pool).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const request=async(method,path,body,cookie)=>{
    const r=await fetch(base+path,{method,headers:{
      ...(body!==undefined?{'Content-Type':'application/json'}:{}),
      ...(method!=='GET'?{'X-Talaeats-Client':'core-v2-lab'}:{}),
      ...(cookie?{Cookie:cookie}:{})
    },body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  };
  const close=async()=>{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await pool.end();};
  return {pool,request,close};
}
async function signupBuyer(request){
  const email='buyer-'+randomUUID()+'@example.test';
  const a=await request('POST','/api/v2/auth/register',{
    email,password:pass,displayName:'Comprador para pruebas'
  });
  assert.equal(a.status,201);
  const login=await request('POST','/api/v2/auth/login',{email,password:pass});
  assert.equal(login.status,200);
  return {id:a.data.id,cookie:login.cookie};
}
async function seedRole(pool,request,role,storeId){
  const id=randomUUID(),email=role+'-'+randomUUID()+'@example.test';
  await pool.query(`
    INSERT INTO tala_core_v2.accounts(id,email,display_name,password_hash,role)
    VALUES($1::uuid,$2,$3,$4,$5)`,
    [id,email,'Operador Lab',await hashPassword(pass),role]);
  if(role==='merchant'&&storeId)await pool.query(`
    INSERT INTO tala_core_v2.restaurant_memberships(restaurant_id,member_id,is_active)
    VALUES($1::uuid,$2::uuid,true)`,[storeId,id]);
  if(role==='driver')await pool.query(`
    INSERT INTO tala_core_v2.driver_profiles(account_id,approved,is_online)
    VALUES($1::uuid,true,true)`,[id]);
  const login=await request('POST','/api/v2/auth/login',{email,password:pass});
  assert.equal(login.status,200);
  return {id,cookie:login.cookie};
}
async function seedStore(pool){
  const store=randomUUID(),product=randomUUID();
  await pool.query(`
    INSERT INTO tala_core_v2.restaurants(id,name,is_open)
    VALUES($1::uuid,'Cocina Lab',true)`,[store]);
  await pool.query(`
    INSERT INTO tala_core_v2.catalog_products(id,restaurant_id,name,price_minor,stock)
    VALUES($1::uuid,$2::uuid,'Burrito Lab',12000,10)`,[product,store]);
  return {store,product};
}
async function newOrder(request,buyer,store,product,fulfillment){
  const checkout={restaurantId:store,fulfillment,
    lines:[{productId:product,quantity:1}],paymentMethod:'cash',
    idempotencyKey:key(),...(fulfillment==='delivery'?{deliveryAddress:'Calle Lab 100, Tala'}:{})};
  const r=await request('POST','/api/v2/orders',checkout,buyer.cookie);
  assert.equal(r.status,201,JSON.stringify(r.data));
  return r.data.order;
}
async function ready(request,merchant,order){
  let version=BigInt(order.version);
  for(const status of ['confirmed','preparing','ready']){
    const response=await request('PATCH','/api/v2/merchant/orders/'+order.id+'/status',{
      status,expectedVersion:String(version),commandKey:key()
    },merchant.cookie);
    assert.equal(response.status,200,JSON.stringify(response.data));
    version=BigInt(response.data.version);
  }
  assert.equal(version,4n);
  return version;
}
test('P0 pickup completa con PIN de comprador, doble acuse de efectivo y custodia no conciliada',{
  skip:!isolated,timeout:40000
},async()=>{
  const {pool,request,close}=await start();
  try{
    const {store,product}=await seedStore(pool);
    const buyer=await signupBuyer(request);
    const intruder=await signupBuyer(request);
    const merchant=await seedRole(pool,request,'merchant',store);
    const order=await newOrder(request,buyer,store,product,'pickup');
    await ready(request,merchant,order);
    const unknown=await request('POST','/api/v2/orders/'+order.id+'/handoff-pin',{},intruder.cookie);
    assert.equal(unknown.status,404);
    const noCash=await request('POST','/api/v2/merchant/orders/'+order.id+'/complete',{
      expectedVersion:'4',commandKey:key(),pin:'00000000'
    },merchant.cookie);
    assert.equal(noCash.status,409);
    assert.equal(noCash.data.code,'CASH_DUAL_ACK_REQUIRED');
    const pin=await request('POST','/api/v2/orders/'+order.id+'/handoff-pin',{},buyer.cookie);
    assert.equal(pin.status,200);
    assert.match(pin.data.pin,/^\d{8}$/);
    assert.equal(pin.data.expiresInSeconds,600);
    const buyerAck=await request('POST','/api/v2/orders/'+order.id+'/cash-paid',{},buyer.cookie);
    assert.equal(buyerAck.status,200);
    assert.equal(buyerAck.data.cashAmountMinor,order.totalMinor);
    const buyerAckAgain=await request('POST','/api/v2/orders/'+order.id+'/cash-paid',{},buyer.cookie);
    assert.equal(buyerAckAgain.status,200);
    assert.equal(buyerAckAgain.data.replayed,true);
    const stillNoCash=await request('POST','/api/v2/merchant/orders/'+order.id+'/complete',{
      expectedVersion:'4',commandKey:key(),pin:pin.data.pin
    },merchant.cookie);
    assert.equal(stillNoCash.status,409);
    assert.equal(stillNoCash.data.code,'CASH_DUAL_ACK_REQUIRED');
    const custodian=await request('POST','/api/v2/merchant/orders/'+order.id+'/cash-received',{},merchant.cookie);
    assert.equal(custodian.status,200);
    const wrong=await request('POST','/api/v2/merchant/orders/'+order.id+'/complete',{
      expectedVersion:'4',commandKey:key(),pin:pin.data.pin==='99999999'?'11111111':'99999999'
    },merchant.cookie);
    assert.equal(wrong.status,409);
    assert.equal(wrong.data.code,'PIN_INVALID');
    const proof=await pool.query('SELECT pin_failures FROM tala_core_v2.order_handoffs WHERE order_id=$1',[order.id]);
    assert.equal(proof.rows[0].pin_failures,1);
    const command={expectedVersion:'4',commandKey:key(),pin:pin.data.pin};
    const delivered=await request('POST','/api/v2/merchant/orders/'+order.id+'/complete',
      command,merchant.cookie);
    assert.equal(delivered.status,200,JSON.stringify(delivered.data));
    assert.equal(delivered.data.status,'delivered');
    assert.equal(delivered.data.version,'5');
    const retried=await request('POST','/api/v2/merchant/orders/'+order.id+'/complete',
      command,merchant.cookie);
    assert.equal(retried.status,200);
    assert.equal(retried.data.replayed,true);
    const tamperedReplay=await request('POST','/api/v2/merchant/orders/'+order.id+'/complete',
      {...command,pin:command.pin==='99999999'?'11111111':'99999999'},merchant.cookie);
    assert.equal(tamperedReplay.status,409);
    assert.equal(tamperedReplay.data.code,'IDEMPOTENCY_CONFLICT');
    const rotate=await request('POST','/api/v2/orders/'+order.id+'/handoff-pin',{},buyer.cookie);
    assert.equal(rotate.status,409);
    const row=await pool.query(`
      SELECT o.status,o.payment_status,o.version,h.custodian_id,h.custodian_role,
        h.custody_settled_at,h.pin_consumed_at,h.cash_amount_minor,
        (SELECT COUNT(*)::int FROM tala_core_v2.order_events e WHERE e.order_id=o.id) events,
        (SELECT COUNT(*)::int FROM tala_core_v2.outbox b WHERE b.aggregate_id=o.id) outbox_count
      FROM tala_core_v2.orders o JOIN tala_core_v2.order_handoffs h ON h.order_id=o.id
      WHERE o.id=$1`,[order.id]);
    const x=row.rows[0];
    assert.equal(x.status,'delivered');
    assert.equal(x.payment_status,'paid');
    assert.equal(x.version,'5');
    assert.equal(x.custodian_id,merchant.id);
    assert.equal(x.custodian_role,'merchant');
    assert.equal(x.custody_settled_at,null);
    assert.ok(x.pin_consumed_at);
    assert.equal(x.cash_amount_minor,order.totalMinor);
    assert.equal(x.events,8); // includes PIN issuance audit with no secret
    assert.equal(x.outbox_count,8);
  }finally{await close();}
});
test('P0 domicilio completo: driver aprobado reclama, recoge, va en ruta y entrega por PIN',{
  skip:!isolated,timeout:40000
},async()=>{
  const {pool,request,close}=await start();
  try{
    const {store,product}=await seedStore(pool);
    const buyer=await signupBuyer(request);
    const merchant=await seedRole(pool,request,'merchant',store);
    const driver=await seedRole(pool,request,'driver');
    const other=await seedRole(pool,request,'driver');
    const order=await newOrder(request,buyer,store,product,'delivery');
    await ready(request,merchant,order);
    const available=await request('GET','/api/v2/driver/available',undefined,driver.cookie);
    assert.equal(available.status,200);
    const availableOrder=available.data.find(o=>o.id===order.id);
    assert.ok(availableOrder);
    assert.equal(availableOrder.version,'4','driver must not guess expectedVersion');
    assert.equal('delivery_address' in availableOrder,false,'no address before assignment');
    const claimCmd={expectedVersion:availableOrder.version,commandKey:key()};
    const claimed=await request('POST','/api/v2/driver/orders/'+order.id+'/claim',
      claimCmd,driver.cookie);
    assert.equal(claimed.status,200,JSON.stringify(claimed.data));
    assert.equal(claimed.data.status,'assigned');
    assert.equal(claimed.data.version,'5');
    const claimedAgain=await request('POST','/api/v2/driver/orders/'+order.id.toUpperCase()+'/claim',
      claimCmd,driver.cookie);
    assert.equal(claimedAgain.status,200);
    assert.equal(claimedAgain.data.replayed,true);
    assert.equal(claimedAgain.data.status,'assigned');
    assert.equal(claimedAgain.data.version,'5');
    const steal=await request('POST','/api/v2/driver/orders/'+order.id+'/claim',{
      expectedVersion:'5',commandKey:key()
    },other.cookie);
    assert.equal(steal.status,409);
    const notMine=await request('GET','/api/v2/driver/orders',undefined,other.cookie);
    assert.equal(notMine.data.some(o=>o.id===order.id),false);
    const mine=await request('GET','/api/v2/driver/orders',undefined,driver.cookie);
    assert.equal(mine.data.some(o=>o.id===order.id&&o.delivery_address==='Calle Lab 100, Tala'),true);
    const invalidCustody=await request('POST','/api/v2/driver/orders/'+order.id+'/cash-received',
      {},other.cookie);
    assert.equal(invalidCustody.status,404);
    let version='5';
    let pickedUpCommand;
    for(const status of ['picked_up','on_the_way']){
      const cmd={status,expectedVersion:version,commandKey:key()};
      if(status==='picked_up')pickedUpCommand=cmd;
      const step=await request('PATCH','/api/v2/driver/orders/'+order.id+'/status',
        cmd,driver.cookie);
      assert.equal(step.status,200,JSON.stringify(step.data));
      version=step.data.version;
    }
    assert.equal(version,'7');
    // Replays must not report the newest state/version. Return original receipt.
    const claimAfterProgress=await request(
      'POST','/api/v2/driver/orders/'+order.id+'/claim',claimCmd,driver.cookie);
    assert.equal(claimAfterProgress.status,200);
    assert.deepEqual(claimAfterProgress.data,{
      orderId:order.id,status:'assigned',version:'5',replayed:true
    });
    const pickupAfterProgress=await request(
      'PATCH','/api/v2/driver/orders/'+order.id+'/status',pickedUpCommand,driver.cookie);
    assert.equal(pickupAfterProgress.status,200);
    assert.deepEqual(pickupAfterProgress.data,{
      orderId:order.id,status:'picked_up',version:'6',replayed:true
    });
    const pin=await request('POST','/api/v2/orders/'+order.id+'/handoff-pin',{},buyer.cookie);
    assert.equal(pin.status,200);
    const cashByBuyer=await request('POST','/api/v2/orders/'+order.id+'/cash-paid',{},buyer.cookie);
    assert.equal(cashByBuyer.status,200);
    const cashByDriver=await request('POST','/api/v2/driver/orders/'+order.id+'/cash-received',{},driver.cookie);
    assert.equal(cashByDriver.status,200);
    const delivered=await request('POST','/api/v2/driver/orders/'+order.id+'/complete',
      {expectedVersion:'7',commandKey:key(),pin:pin.data.pin},driver.cookie);
    assert.equal(delivered.status,200,JSON.stringify(delivered.data));
    assert.equal(delivered.data.status,'delivered');
    assert.equal(delivered.data.version,'8');
    const final=await pool.query(`
      SELECT o.status,o.payment_status,h.custodian_id,h.custodian_role,h.custody_settled_at
      FROM tala_core_v2.orders o JOIN tala_core_v2.order_handoffs h ON h.order_id=o.id
      WHERE o.id=$1`,[order.id]);
    assert.equal(final.rows[0].status,'delivered');
    assert.equal(final.rows[0].payment_status,'paid');
    assert.equal(final.rows[0].custodian_id,driver.id);
    assert.equal(final.rows[0].custodian_role,'driver');
    assert.equal(final.rows[0].custody_settled_at,null);
  }finally{await close();}
});
test('P0 PIN no puede reutilizarse, bloquea 5 intentos, comprador puede rotarlo',{
  skip:!isolated,timeout:40000
},async()=>{
  const {pool,request,close}=await start();
  try{
    const {store,product}=await seedStore(pool);
    const buyer=await signupBuyer(request);
    const merchant=await seedRole(pool,request,'merchant',store);
    const order=await newOrder(request,buyer,store,product,'pickup');
    await ready(request,merchant,order);
    const first=await request('POST','/api/v2/orders/'+order.id+'/handoff-pin',{},buyer.cookie);
    assert.equal(first.status,200);
    await request('POST','/api/v2/orders/'+order.id+'/cash-paid',{},buyer.cookie);
    await request('POST','/api/v2/merchant/orders/'+order.id+'/cash-received',{},merchant.cookie);
    for(let i=0;i<5;i++){
      const err=await request('POST','/api/v2/merchant/orders/'+order.id+'/complete',
        {expectedVersion:'4',commandKey:key(),pin:'00000000'},merchant.cookie);
      assert.equal(err.status,409);
      assert.equal(err.data.code,'PIN_INVALID');
    }
    const blocked=await request('POST','/api/v2/merchant/orders/'+order.id+'/complete',
      {expectedVersion:'4',commandKey:key(),pin:first.data.pin},merchant.cookie);
    assert.equal(blocked.status,409);
    assert.equal(blocked.data.code,'PIN_ATTEMPTS_EXCEEDED');
    const renewed=await request('POST','/api/v2/orders/'+order.id+'/handoff-pin',{},buyer.cookie);
    assert.equal(renewed.status,200);
    const oldPin=await request('POST','/api/v2/merchant/orders/'+order.id+'/complete',
      {expectedVersion:'4',commandKey:key(),pin:first.data.pin},merchant.cookie);
    // Random replacement PIN may theoretically match; guard statistically irrelevant
    if(first.data.pin!==renewed.data.pin){
      assert.equal(oldPin.status,409);
      assert.equal(oldPin.data.code,'PIN_INVALID');
    }
    const final=await request('POST','/api/v2/merchant/orders/'+order.id+'/complete',
      {expectedVersion:'4',commandKey:key(),pin:renewed.data.pin},merchant.cookie);
    assert.equal(final.status,200,JSON.stringify(final.data));
    const cashAgain=await request('POST','/api/v2/orders/'+order.id+'/cash-paid',{},buyer.cookie);
    assert.equal(cashAgain.status,409);
  }finally{await close();}
});

test('P0 PIN generation rate limit is atomic and recoverable after ten minutes',{
  skip:!isolated,timeout:40000
},async()=>{
  const {pool,request,close}=await start();
  try{
    const {store,product}=await seedStore(pool);
    const buyer=await signupBuyer(request);
    const seller=await seedRole(pool,request,'merchant',store);
    const order=await newOrder(request,buyer,store,product,'pickup');
    await ready(request,seller,order);
    for(let n=0;n<6;n++){
      const result=await request('POST','/api/v2/orders/'+order.id+'/handoff-pin',
        {},buyer.cookie);
      assert.equal(result.status,200,JSON.stringify(result.data));
      assert.match(result.data.pin,/^\d{8}$/);
    }
    const extra=await request('POST','/api/v2/orders/'+order.id+'/handoff-pin',
      {},buyer.cookie);
    assert.equal(extra.status,429);
    assert.equal(extra.data.code,'PIN_GENERATION_RATE_LIMITED');
    const blocked=await pool.query(`
      SELECT pin_generation_count FROM tala_core_v2.order_handoffs
      WHERE order_id=$1::uuid`,[order.id]);
    assert.equal(blocked.rows[0].pin_generation_count,6);
    await pool.query(`
      UPDATE tala_core_v2.order_handoffs
      SET pin_window_started_at=now()-interval '11 minutes'
      WHERE order_id=$1::uuid`,[order.id]);
    const recovered=await request('POST','/api/v2/orders/'+order.id+'/handoff-pin',
      {},buyer.cookie);
    assert.equal(recovered.status,200);
    const reset=await pool.query(`
      SELECT pin_generation_count FROM tala_core_v2.order_handoffs
      WHERE order_id=$1::uuid`,[order.id]);
    assert.equal(reset.rows[0].pin_generation_count,1);
    const events=await pool.query(`
      SELECT e.data,b.payload
      FROM tala_core_v2.order_events e
      JOIN tala_core_v2.outbox b ON b.event_key=e.event_key
      WHERE e.order_id=$1::uuid AND b.event_type='order.pin.issued'`,[order.id]);
    assert.equal(events.rows.length,7);
    for(const x of events.rows){
      assert.ok(!('pin' in x.data),'PIN must not be in audit event');
      assert.ok(!('pin' in x.payload),'PIN must not be in outbox');
    }
  }finally{await close();}
});
