import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {enrollCourier,approveCourier,setCourierOnline,recordCourierPosition,
 reserveDelivery,reserveNearestDelivery,reassignUnavailableDelivery,LogisticsError}
 from '../src/modules/modulo-2-logistica/index.ts';
const db=process.env.PG_CI_URL??'';
const enabled=(()=>{try{const u=new URL(db);return u.pathname==='/tala_core_v2_test'
 &&['127.0.0.1','localhost'].includes(u.hostname)}catch{return false}})();
const pool=()=>new Pool({connectionString:db,max:12,connectionTimeoutMillis:3000});
const p=(latitude=20.653,longitude=-103.699)=>({latitude,longitude});
const z=()=> 'reroute_'+randomUUID().slice(0,12);
const key=()=> 'cmd-'+randomUUID();
const req=zone=>({orderId:randomUUID(),restaurantId:randomUUID(),
 deliveryZone:zone,fulfillment:'delivery',orderStatus:'ready'});
const expectCode=code=>e=>e instanceof LogisticsError&&e.code===code;
// Synthetic, test-only Orders pre-pickup approval. Never use in deployed API.
const verify=async (_client,context)=>Boolean(context.orderId&&context.restaurantId);
// Synthetic CI-only Orders update. Real backend uses commitOrdersReassignment.
const synchronize=async()=>true;

async function setup(pool,zone,point){
 const id=randomUUID();
 await enrollCourier(pool,id,zone,1);
 await approveCourier(pool,id,true);
 await setCourierOnline(pool,id,true);
 if(point)await recordCourierPosition(pool,id,point,10);
 return id;
}
test('Reroute v2: offline courier safely replaced; one order and 2 immutable events',{
 skip:!enabled
},async()=>{
 const dbpool=pool();
 try{
  const zone=z(),old=await setup(dbpool,zone,p(20.6531,-103.699)),
   next=await setup(dbpool,zone,p(20.655,-103.699));
  const order=req(zone),initial=await reserveNearestDelivery(dbpool,order,key(),p());
  assert.equal(initial.decision,'RESERVED');
  assert.equal(initial.courierId,old);
  await setCourierOnline(dbpool,old,false);
  const cmd=key();
  const rr=await reassignUnavailableDelivery(dbpool,order.orderId,'1',cmd,p(),20000,verify,synchronize);
  assert.deepEqual(rr,{decision:'REASSIGNED',orderId:order.orderId,
   previousCourierId:old,courierId:next,version:'2',replayed:false});
  assert.deepEqual(await reassignUnavailableDelivery(dbpool,order.orderId,'1',cmd,p(),20000,verify,synchronize),
   {...rr,replayed:true});
  const rows=await dbpool.query(
   "SELECT r.courier_id,r.version,r.status,"+
   "(SELECT count(*)::int FROM tala_logistics_v2.dispatch_events e "+
   " WHERE e.order_id=r.order_id) events,"+
   "(SELECT count(*)::int FROM tala_logistics_v2.outbox b "+
   " JOIN tala_logistics_v2.dispatch_events e ON e.event_key=b.event_key "+
   " WHERE e.order_id=r.order_id) outbox "+
   "FROM tala_logistics_v2.dispatch_reservations r WHERE r.order_id=$1",[order.orderId]);
  assert.deepEqual(rows.rows[0],{
   courier_id:next,version:'2',status:'reserved',events:2,outbox:2
  });
  const ev=await dbpool.query(
   "SELECT details FROM tala_logistics_v2.dispatch_events "+
   "WHERE order_id=$1 AND event_type='dispatch.reassigned'",[order.orderId]);
  assert.equal(ev.rows[0].details.previousCourierId,old);
  assert.equal(ev.rows[0].details.courierId,next);
  assert.equal(ev.rows[0].details.dispatchEngineVersion,'2.0.0-lab');
  assert.equal('latitude' in ev.rows[0].details,false);
  assert.equal('longitude' in ev.rows[0].details,false);
 }finally{await dbpool.end();}
});
test('Reroute v2: active and fresh courier is protected from arbitrary reassignment',{
 skip:!enabled
},async()=>{
 const dbpool=pool();
 try{
  const zone=z(),old=await setup(dbpool,zone,p()),next=await setup(dbpool,zone,p(20.66,-103.699));
  const order=req(zone);
  const initial=await reserveNearestDelivery(dbpool,order,key(),p());
  assert.equal(initial.courierId,old);
  const result=await reassignUnavailableDelivery(dbpool,order.orderId,'1',key(),p(),20000,verify,synchronize);
  assert.deepEqual(result,{decision:'STILL_AVAILABLE',orderId:order.orderId,currentCourierId:old});
  const row=await dbpool.query(
   "SELECT version,courier_id FROM tala_logistics_v2.dispatch_reservations WHERE order_id=$1",
   [order.orderId]);
  assert.deepEqual(row.rows[0],{version:'1',courier_id:old});
  assert.notEqual(next,old);
 }finally{await dbpool.end();}
});
test('Reroute v2: fails closed when no substitute available; no phantom events',{
 skip:!enabled
},async()=>{
 const dbpool=pool();
 try{
  const zone=z(),old=await setup(dbpool,zone,p());
  const order=req(zone),a=await reserveNearestDelivery(dbpool,order,key(),p());
  assert.equal(a.decision,'RESERVED');
  await setCourierOnline(dbpool,old,false);
  const r=await reassignUnavailableDelivery(dbpool,order.orderId,'1',key(),p(),20000,verify,synchronize);
  assert.deepEqual(r,{decision:'NO_AVAILABLE_COURIER',orderId:order.orderId,
   currentCourierId:old});
  const q=await dbpool.query(
   "SELECT version,courier_id FROM tala_logistics_v2.dispatch_reservations "+
   "WHERE order_id=$1",[order.orderId]);
  assert.deepEqual(q.rows[0],{version:'1',courier_id:old});
  const events=await dbpool.query(
   "SELECT count(*)::int AS n FROM tala_logistics_v2.dispatch_events WHERE order_id=$1",
   [order.orderId]);
  assert.equal(events.rows[0].n,1);
 }finally{await dbpool.end();}
});
test('Reroute v2: rejects stale versions and non-GPS legacy reservations',{
 skip:!enabled
},async()=>{
 const dbpool=pool();
 try{
  const zone=z(),old=await setup(dbpool,zone,p());
  const order=req(zone);
  await reserveNearestDelivery(dbpool,order,key(),p());
  await setCourierOnline(dbpool,old,false);
  await assert.rejects(reassignUnavailableDelivery(dbpool,order.orderId,'2',key(),p(),20000,verify,synchronize),
   expectCode('LOGISTICS_VERSION_CONFLICT'));
  const zone2=z();await setup(dbpool,zone2,null);
  const oldOrder=req(zone2);
  await reserveDelivery(dbpool,oldOrder,key());
  await assert.rejects(reassignUnavailableDelivery(dbpool,oldOrder.orderId,'1',key(),p(),20000,verify,synchronize),
   expectCode('LOGISTICS_REROUTE_REQUIRES_GEO_RESERVATION'));
  await assert.rejects(reassignUnavailableDelivery(dbpool,order.orderId,'1',key(),p(91,0),20000,verify,synchronize),
   expectCode('LOGISTICS_REROUTE_INPUT_INVALID'));
 }finally{await dbpool.end();}
});
test('Reroute v2: two simultaneous reroutes cannot assign same order twice',{
 skip:!enabled,timeout:30000
},async()=>{
 const dbpool=pool();
 try{
  const zone=z(),old=await setup(dbpool,zone,p(20.6531,-103.699)),
   next=await setup(dbpool,zone,p(20.654,-103.699));
  const order=req(zone);
  assert.equal((await reserveNearestDelivery(dbpool,order,key(),p())).courierId,old);
  await setCourierOnline(dbpool,old,false);
  const cmd=key();
  const results=await Promise.all([
   reassignUnavailableDelivery(dbpool,order.orderId,'1',cmd,p(),20000,verify,synchronize),
   reassignUnavailableDelivery(dbpool,order.orderId,'1',cmd,p(),20000,verify,synchronize)
  ]);
  assert.equal(results.every(x=>x.decision==='REASSIGNED'),true);
  assert.equal(results.every(x=>x.courierId===next),true);
  assert.deepEqual(results.map(x=>x.replayed).sort(),[false,true]);
  const q=await dbpool.query(
   "SELECT count(*)::int AS n FROM tala_logistics_v2.dispatch_events "+
   "WHERE order_id=$1 AND event_type='dispatch.reassigned'",[order.orderId]);
  assert.equal(q.rows[0].n,1);
 }finally{await dbpool.end();}
});

test('Security: reroute requires Orders pre-pickup verifier and fails closed on denial',{
 skip:!enabled
},async()=>{
 const dbpool=pool();
 try{
  const zone=z(),old=await setup(dbpool,zone,p(20.6531,-103.699));
  await setup(dbpool,zone,p(20.655,-103.699));
  const order=req(zone);
  assert.equal((await reserveNearestDelivery(dbpool,order,key(),p())).courierId,old);
  await setCourierOnline(dbpool,old,false);
  const cmd=key();
  await assert.rejects(reassignUnavailableDelivery(
   dbpool,order.orderId,'1',cmd,p()),
   expectCode('LOGISTICS_ORDER_VERIFICATION_REQUIRED'));
  await assert.rejects(reassignUnavailableDelivery(
   dbpool,order.orderId,'1',cmd,p(),20000,async()=>false,synchronize),
   expectCode('LOGISTICS_ORDER_NOT_VERIFIED_PRE_PICKUP'));
  const unchanged=await dbpool.query(
   "SELECT version,courier_id FROM tala_logistics_v2.dispatch_reservations WHERE order_id=$1",
   [order.orderId]);
  assert.deepEqual(unchanged.rows[0],{version:'1',courier_id:old});
  const events=await dbpool.query(
   "SELECT count(*)::int AS n FROM tala_logistics_v2.dispatch_events WHERE order_id=$1",
   [order.orderId]);
  assert.equal(events.rows[0].n,1);
  // The temporary CI-only stub accepts the original order, not an HTTP claimant.
  let received=false;
  const check=async (client,context)=>{
   received=true;
   assert.equal(context.orderId,order.orderId);
   assert.equal(context.restaurantId,order.restaurantId);
   assert.equal(context.courierId,old);
   assert.equal(context.zone,zone);
   const r=await client.query('SELECT 1 AS ok');
   return r.rows[0].ok===1;
  };
  assert.equal((await reassignUnavailableDelivery(
   dbpool,order.orderId,'1',cmd,p(),20000,check,synchronize)).decision,'REASSIGNED');
  assert.equal(received,true);
 }finally{await dbpool.end();}
});
test('Security: changed reroute target/radius on same command key is not a replay',{
 skip:!enabled
},async()=>{
 const dbpool=pool();
 try{
  const zone=z(),old=await setup(dbpool,zone,p(20.6531,-103.699));
  await setup(dbpool,zone,p(20.655,-103.699));
  const order=req(zone),cmd=key();
  await reserveNearestDelivery(dbpool,order,key(),p());
  await setCourierOnline(dbpool,old,false);
  const prior=await reassignUnavailableDelivery(
   dbpool,order.orderId,'1',cmd,p(),20000,verify,synchronize);
  assert.equal(prior.decision,'REASSIGNED');
  await assert.rejects(reassignUnavailableDelivery(
   dbpool,order.orderId,'1',cmd,p(20.654,-103.699),20000,verify,synchronize),
   expectCode('LOGISTICS_IDEMPOTENCY_INPUT_CONFLICT'));
  await assert.rejects(reassignUnavailableDelivery(
   dbpool,order.orderId,'1',cmd,p(),18000,verify,synchronize),
   expectCode('LOGISTICS_IDEMPOTENCY_INPUT_CONFLICT'));
  assert.equal((await reassignUnavailableDelivery(
   dbpool,order.orderId,'1',cmd,p(),20000,verify,synchronize)).replayed,true);
 }finally{await dbpool.end();}
});

test('Security: original reserve command cannot replay after courier reroute',{
 skip:!enabled
},async()=>{
 const dbpool=pool();
 try{
  const zone=z(),old=await setup(dbpool,zone,p(20.6531,-103.699));
  await setup(dbpool,zone,p(20.655,-103.699));
  const order=req(zone),originalKey=key();
  const first=await reserveNearestDelivery(dbpool,order,originalKey,p());
  assert.equal(first.courierId,old);
  await setCourierOnline(dbpool,old,false);
  assert.equal((await reassignUnavailableDelivery(dbpool,order.orderId,'1',key(),p(),20000,verify,synchronize)).decision,'REASSIGNED');
  await assert.rejects(
   reserveNearestDelivery(dbpool,order,originalKey,p()),
   expectCode('LOGISTICS_RESERVATION_SUPERSEDED')
  );
  const evidence=await dbpool.query(
   "SELECT count(*)::int AS n FROM tala_logistics_v2.dispatch_events WHERE order_id=$1",
   [order.orderId]);
  assert.equal(evidence.rows[0].n,2);
 }finally{await dbpool.end();}
});

test('Security: old reroute receipt is superseded after a second reassignment',{
 skip:!enabled,timeout:30000
},async()=>{
 const dbpool=pool();
 try{
  const zone=z();
  const a=await setup(dbpool,zone,p(20.6531,-103.699));
  const b=await setup(dbpool,zone,p(20.654,-103.699));
  const c=await setup(dbpool,zone,p(20.655,-103.699));
  const order=req(zone),firstKey=key();
  assert.equal((await reserveNearestDelivery(dbpool,order,key(),p())).courierId,a);
  await setCourierOnline(dbpool,a,false);
  const first=await reassignUnavailableDelivery(dbpool,order.orderId,'1',firstKey,p(),20000,verify,synchronize);
  assert.equal(first.courierId,b);
  await setCourierOnline(dbpool,b,false);
  const second=await reassignUnavailableDelivery(dbpool,order.orderId,'2',key(),p(),20000,verify,synchronize);
  assert.equal(second.courierId,c);
  await assert.rejects(
   reassignUnavailableDelivery(dbpool,order.orderId,'1',firstKey,p(),20000,verify,synchronize),
   expectCode('LOGISTICS_REROUTE_SUPERSEDED')
  );
  const events=await dbpool.query(
   "SELECT count(*)::int AS n FROM tala_logistics_v2.dispatch_events WHERE order_id=$1",
   [order.orderId]);
  assert.equal(events.rows[0].n,3);
 }finally{await dbpool.end();}
});
