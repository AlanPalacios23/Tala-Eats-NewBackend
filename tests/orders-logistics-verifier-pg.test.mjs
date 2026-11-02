import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {verifyOrdersPrePickup} from '../src/integrations/orders-logistics/verify-pre-pickup.ts';
import {commitOrdersReassignment} from '../src/integrations/orders-logistics/commit-reassignment.ts';
import {inspectDispatchConsistency} from '../src/integrations/orders-logistics/inspect-consistency.ts';
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
async function approvedM1Courier(p,id){
 await p.query(
  "INSERT INTO tala_core_v2.accounts (id,email,display_name,password_hash,role) "+
  "VALUES($1,$2,$3,$4,'driver')",
  [id,randomUUID()+'@lab.test','QA Driver','lab-only-not-a-real-password']
 );
 await p.query("INSERT INTO tala_core_v2.driver_profiles(account_id,approved,is_online) "+
  "VALUES($1,true,true)",[id]);
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
  await approvedM1Courier(p,replacement);
  const r=await reserveNearestDelivery(p,{
   orderId:o.id,restaurantId:o.restaurantId,deliveryZone:z,
   orderStatus:'ready',fulfillment:'delivery'
  },key(),pickup);
  assert.equal(r.decision,'RESERVED');
  assert.equal(r.courierId,original);
  await setCourierOnline(p,original,false);
  const changed=await reassignUnavailableDelivery(p,o.id,'1',key(),pickup,20000,
   verifyOrdersPrePickup,commitOrdersReassignment);
  assert.equal(changed.decision,'REASSIGNED');
  assert.equal(changed.courierId,replacement);
  const dbOrder=await p.query(
   "SELECT o.status,o.version,a.driver_id FROM tala_core_v2.orders o "+
   "JOIN tala_core_v2.order_driver_assignments a ON a.order_id=o.id "+
   "WHERE o.id=$1",[o.id]);
  assert.equal(dbOrder.rows[0].status,'assigned');
  assert.equal(dbOrder.rows[0].driver_id,replacement,
   'Orders and Logistics must commit the SAME replacement');
  assert.equal(dbOrder.rows[0].version,'2');
  const audit=await p.query(
   "SELECT COUNT(*)::int n FROM tala_core_v2.order_events "+
   "WHERE order_id=$1 AND data->>'courierId'=$2",[o.id,replacement]);
  assert.equal(audit.rows[0].n,1);
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
  await approvedM1Courier(p,replacement);
  const r=await reserveNearestDelivery(p,{
   orderId:o.id,restaurantId:o.restaurantId,deliveryZone:z,
   orderStatus:'ready',fulfillment:'delivery'
  },key(),pickup);
  assert.equal(r.courierId,original);
  await setCourierOnline(p,original,false);
  await p.query("UPDATE tala_core_v2.orders SET status='picked_up' WHERE id=$1",[o.id]);
  await assert.rejects(reassignUnavailableDelivery(
   p,o.id,'1',key(),pickup,20000,verifyOrdersPrePickup,commitOrdersReassignment),
   rejectCode('LOGISTICS_ORDER_NOT_VERIFIED_PRE_PICKUP'));
  const unchanged=await p.query(
   'SELECT courier_id,version FROM tala_logistics_v2.dispatch_reservations WHERE order_id=$1',[o.id]);
  assert.deepEqual(unchanged.rows[0],{courier_id:original,version:'1'});
 }finally{await p.end();}
});

test('Orders bridge: rejected replacement rolls back BOTH modules and outboxes',{
 skip:!enabled,timeout:30000
},async()=>{
 const p=pool();
 try{
  const z=zone(),original=randomUUID(),replacement=randomUUID();
  await courier(p,z,original,20.6531);
  await courier(p,z,replacement,20.655);
  const order=await orderFixture(p,original);
  const reserve=await reserveNearestDelivery(p,{
   orderId:order.id,restaurantId:order.restaurantId,deliveryZone:z,
   orderStatus:'ready',fulfillment:'delivery'
  },key(),pickup);
  assert.equal(reserve.courierId,original);
  await setCourierOnline(p,original,false);
  const before=await p.query(
   'SELECT COUNT(*)::int AS n FROM tala_logistics_v2.dispatch_events WHERE order_id=$1',
   [order.id]);
  await assert.rejects(
   reassignUnavailableDelivery(p,order.id,'1',key(),pickup,20000,
    verifyOrdersPrePickup,commitOrdersReassignment),
   rejectCode('LOGISTICS_ORDER_SYNC_FAILED')
  );
  const logistics=await p.query(
   'SELECT courier_id,version FROM tala_logistics_v2.dispatch_reservations WHERE order_id=$1',
   [order.id]);
  assert.deepEqual(logistics.rows[0],{courier_id:original,version:'1'});
  const orders=await p.query(
   'SELECT driver_id FROM tala_core_v2.order_driver_assignments WHERE order_id=$1',
   [order.id]);
  assert.equal(orders.rows[0].driver_id,original);
  const after=await p.query(
   'SELECT COUNT(*)::int AS n FROM tala_logistics_v2.dispatch_events WHERE order_id=$1',
   [order.id]);
  assert.equal(after.rows[0].n,before.rows[0].n);
  // Once the replacement is approved in M1, the same order is recoverable.
  await approvedM1Courier(p,replacement);
  const recovered=await reassignUnavailableDelivery(p,order.id,'1',key(),pickup,20000,
   verifyOrdersPrePickup,commitOrdersReassignment);
  assert.equal(recovered.decision,'REASSIGNED');
  assert.equal(recovered.courierId,replacement);
 }finally{await p.end();}
});
test('Orders bridge: forced failure of M1 callback rolls back M2 reservation',{
 skip:!enabled,timeout:30000
},async()=>{
 const p=pool();
 try{
  const z=zone(),original=randomUUID(),replacement=randomUUID();
  await courier(p,z,original,20.6531);
  await courier(p,z,replacement,20.655);
  const order=await orderFixture(p,original);
  await approvedM1Courier(p,replacement);
  await reserveNearestDelivery(p,{
   orderId:order.id,restaurantId:order.restaurantId,deliveryZone:z,
   orderStatus:'ready',fulfillment:'delivery'
  },key(),pickup);
  await setCourierOnline(p,original,false);
  const fail=async(client,ctx)=>{
    const result=await commitOrdersReassignment(client,ctx);
    assert.equal(result,true);
    throw Error('CI_SIMULATED_COMMIT_FAILURE');
  };
  await assert.rejects(
   reassignUnavailableDelivery(p,order.id,'1',key(),pickup,20000,
    verifyOrdersPrePickup,fail),
   /CI_SIMULATED_COMMIT_FAILURE/
  );
  const q=await p.query(
   "SELECT a.driver_id,o.version,"+
   "(SELECT courier_id FROM tala_logistics_v2.dispatch_reservations WHERE order_id=o.id) AS logistics_courier "+
   "FROM tala_core_v2.orders o JOIN tala_core_v2.order_driver_assignments a ON a.order_id=o.id "+
   "WHERE o.id=$1",[order.id]);
  assert.equal(q.rows[0].driver_id,original);
  assert.equal(q.rows[0].logistics_courier,original);
  assert.equal(q.rows[0].version,'1');
  const ev=await p.query(
   "SELECT COUNT(*)::int n FROM tala_core_v2.order_events WHERE order_id=$1",[order.id]);
  assert.equal(ev.rows[0].n,0);
 }finally{await p.end();}
});

test('Orders bridge: read-only audit detects and explains a driver divergence',{
 skip:!enabled,timeout:30000
},async()=>{
 const p=pool();
 try{
  const z=zone(),old=randomUUID(),next=randomUUID();
  await courier(p,z,old,20.6531);
  await courier(p,z,next,20.655);
  const o=await orderFixture(p,old);
  await approvedM1Courier(p,next);
  const initial=await reserveNearestDelivery(p,{
   orderId:o.id,restaurantId:o.restaurantId,deliveryZone:z,
   orderStatus:'ready',fulfillment:'delivery'
  },key(),pickup);
  assert.equal(initial.courierId,old);
  assert.equal((await inspectDispatchConsistency(p,o.id)).status,'CONSISTENT');
  await setCourierOnline(p,old,false);
  const replaced=await reassignUnavailableDelivery(p,o.id,'1',key(),pickup,20000,
    verifyOrdersPrePickup,commitOrdersReassignment);
  assert.equal(replaced.courierId,next);
  const audit=await inspectDispatchConsistency(p,o.id);
  assert.deepEqual(audit,{
    orderId:o.id,status:'CONSISTENT',
    logisticsCourierId:next,ordersCourierId:next
  });
  // Corruption simulation in disposable PostgreSQL CI only.
  await p.query(
   'UPDATE tala_core_v2.order_driver_assignments SET driver_id=$2 WHERE order_id=$1',
   [o.id,old]
  );
  const divergent=await inspectDispatchConsistency(p,o.id);
  assert.equal(divergent.status,'COURIER_MISMATCH');
  assert.equal(divergent.logisticsCourierId,next);
  assert.equal(divergent.ordersCourierId,old);
  await assert.rejects(inspectDispatchConsistency(p,'fake'),
    /LOGISTICS_AUDIT_ORDER_INVALID/);
 }finally{await p.end();}
});
