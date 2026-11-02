import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {verifyOrdersPrePickup} from '../src/integrations/orders-logistics/verify-pre-pickup.ts';
import {enrollCourier,approveCourier,setCourierOnline,recordCourierPosition,
  reserveNearestDelivery,reassignUnavailableDelivery,LogisticsError}
 from '../src/modules/modulo-2-logistica/index.ts';
const db=process.env.PG_CI_URL??'';
const enabled=(()=>{try{const u=new URL(db);return u.pathname==='/tala_core_v2_test'
 &&['127.0.0.1','localhost'].includes(u.hostname)}catch{return false}})();
const pool=()=>new Pool({connectionString:db,max:8,connectionTimeoutMillis:3000});
const key=()=> 'bridge-'+randomUUID();
const zone=()=> 'bridge_'+randomUUID().slice(0,12);
const pickup={latitude:20.653,longitude:-103.699};
const rejectCode=code=>e=>e instanceof LogisticsError&&e.code===code;
async function courier(p,z,id,lat){
 await enrollCourier(p,id,z,1);
 await approveCourier(p,id,true);
 await setCourierOnline(p,id,true);
 await recordCourierPosition(p,id,{latitude:lat,longitude:-103.699},10);
}
async function orderFixture(p,courierId,status='assigned'){
 const id=randomUUID(),restaurantId=randomUUID();
 await p.query(
  "INSERT INTO tala_core_v2.accounts (id,email,display_name,password_hash,role) "+
  "VALUES($1,$2,$3,$4,'driver')",
  [courierId,randomUUID()+'@lab.test','CI Driver','lab-only-not-a-real-password']
 );
 await p.query(
  "INSERT INTO tala_core_v2.orders "+
  "(id,buyer_id,restaurant_id,fulfillment,status,payment_method,"+
  "payment_status,currency,total_minor,pricing_policy_version,price_snapshot,"+
  "idempotency_key,request_hash) VALUES "+
  "($1,$2,$3,'delivery',$4,'cash','pending','MXN',100,'lab','{}'::jsonb,$5,$6)",
  [id,randomUUID(),restaurantId,status,'ci-'+randomUUID(),'f'.repeat(64)]
 );
 await p.query(
  "INSERT INTO tala_core_v2.order_driver_assignments(order_id,driver_id) "+
  "VALUES($1,$2)",[id,courierId]
 );
 return {id,restaurantId};
}
async function verify(p,o,courierId){
 const client=await p.connect();
 try{
  await client.query('BEGIN');
  return await verifyOrdersPrePickup(client,{
   orderId:o.id,restaurantId:o.restaurantId,courierId,zone:'lab'
  });
 }finally{
  await client.query('ROLLBACK');client.release();
 }
}
test('Orders bridge: real SQL requires order assigned, correct merchant and driver',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const driver=randomUUID(),o=await orderFixture(p,driver);
  assert.equal(await verify(p,o,driver),true);
  assert.equal(await verify(p,o,randomUUID()),false);
  assert.equal(await verify(p,{...o,restaurantId:randomUUID()},driver),false);
  await p.query("UPDATE tala_core_v2.orders SET status='picked_up' WHERE id=$1",[o.id]);
  assert.equal(await verify(p,o,driver),false);
  await p.query("UPDATE tala_core_v2.orders SET status='assigned' WHERE id=$1",[o.id]);
  await p.query(
   "INSERT INTO tala_core_v2.order_events(order_id,event_key,previous_status,"+
   "new_status,actor_role) VALUES($1,$2,'assigned','picked_up','driver')",
   [o.id,'picked-'+randomUUID()]);
  assert.equal(await verify(p,o,driver),false,
   'pickup evidence must bar reroute even if status was reset');
 }finally{await p.end();}
});
test('Orders bridge: handoff PIN consumed refuses reassignment',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const driver=randomUUID(),o=await orderFixture(p,driver);
  assert.equal(await verify(p,o,driver),true);
  await p.query(
   "INSERT INTO tala_core_v2.order_handoffs(order_id,cash_amount_minor,pin_consumed_at) "+
   "VALUES($1,100,clock_timestamp())",[o.id]
  );
  assert.equal(await verify(p,o,driver),false);
 }finally{await p.end();}
});
test('Orders bridge: reroute only with actual pre-pickup M1 order lock',{
 skip:!enabled,timeout:30000
},async()=>{
 const p=pool();
 try{
  const z=zone(),original=randomUUID(),replacement=randomUUID();
  await courier(p,z,original,20.6531);
  await courier(p,z,replacement,20.655);
  const o=await orderFixture(p,original);
  const r=await reserveNearestDelivery(p,{
   orderId:o.id,restaurantId:o.restaurantId,deliveryZone:z,
   orderStatus:'ready',fulfillment:'delivery'
  },key(),pickup);
  assert.equal(r.decision,'RESERVED');
  assert.equal(r.courierId,original);
  await setCourierOnline(p,original,false);
  const changed=await reassignUnavailableDelivery(p,o.id,'1',key(),pickup,20000,verifyOrdersPrePickup);
  assert.equal(changed.decision,'REASSIGNED');
  assert.equal(changed.courierId,replacement);
  const dbOrder=await p.query(
   "SELECT status FROM tala_core_v2.orders WHERE id=$1",[o.id]);
  assert.equal(dbOrder.rows[0].status,'assigned',
   'Logistics does not mutate an M1 order or driver claim');
 }finally{await p.end();}
});
test('Orders bridge: M1 pickup prevents any mutation in logistics',{
 skip:!enabled,timeout:30000
},async()=>{
 const p=pool();
 try{
  const z=zone(),original=randomUUID(),replacement=randomUUID();
  await courier(p,z,original,20.6531);
  await courier(p,z,replacement,20.655);
  const o=await orderFixture(p,original);
  const r=await reserveNearestDelivery(p,{
   orderId:o.id,restaurantId:o.restaurantId,deliveryZone:z,
   orderStatus:'ready',fulfillment:'delivery'
  },key(),pickup);
  assert.equal(r.courierId,original);
  await setCourierOnline(p,original,false);
  await p.query("UPDATE tala_core_v2.orders SET status='picked_up' WHERE id=$1",[o.id]);
  await assert.rejects(reassignUnavailableDelivery(
   p,o.id,'1',key(),pickup,20000,verifyOrdersPrePickup),
   rejectCode('LOGISTICS_ORDER_NOT_VERIFIED_PRE_PICKUP'));
  const unchanged=await p.query(
   'SELECT courier_id,version FROM tala_logistics_v2.dispatch_reservations WHERE order_id=$1',[o.id]);
  assert.deepEqual(unchanged.rows[0],{courier_id:original,version:'1'});
 }finally{await p.end();}
});
