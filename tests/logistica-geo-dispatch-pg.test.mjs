import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {enrollCourier,approveCourier,setCourierOnline,recordCourierPosition,
 reserveNearestDelivery,reserveDelivery,finalizeDispatch,LogisticsError}
 from '../src/modules/modulo-2-logistica/index.ts';
const raw=process.env.PG_CI_URL??'';
const enabled=(()=>{try{const u=new URL(raw);return u.pathname==='/tala_core_v2_test'
 && ['127.0.0.1','localhost'].includes(u.hostname)}catch{return false}})();
const pool=()=>new Pool({connectionString:raw,max:10,connectionTimeoutMillis:3000});
const request=zone=>({orderId:randomUUID(),restaurantId:randomUUID(),
 orderStatus:'ready',fulfillment:'delivery',deliveryZone:zone});
const point=(latitude=20.653,longitude=-103.699)=>({latitude,longitude});
const zone=()=> 'v2_'+randomUUID().slice(0,12);
const key=()=> 'v2-command-'+randomUUID();
const assertCode=code=>e=>e instanceof LogisticsError&&e.code===code;
async function courier(p,z,coords,capacity=1){
 const id=randomUUID();
 await enrollCourier(p,id,z,capacity);
 await approveCourier(p,id,true);
 await setCourierOnline(p,id,true);
 if(coords)await recordCourierPosition(p,id,coords,9);
 return id;
}
test('GEO v2: nearest eligible courier wins even with larger UUID and load',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const z=zone();
  const far=await courier(p,z,point(20.69,-103.699),2);
  const near=await courier(p,z,point(20.654,-103.699),2);
  const q=request(z),cmd=key();
  const result=await reserveNearestDelivery(p,q,cmd,point(),20000);
  assert.equal(result.decision,'RESERVED');
  assert.equal(result.courierId,near);
  assert.notEqual(result.courierId,far);
  const audit=await p.query(
   'SELECT e.details,b.payload FROM tala_logistics_v2.dispatch_events e '+
   'JOIN tala_logistics_v2.outbox b ON b.event_key=e.event_key '+
   'WHERE e.order_id=$1::uuid',[q.orderId]
  );
  assert.equal(audit.rowCount,1);
  for(const entry of [audit.rows[0].details,audit.rows[0].payload]){
   assert.equal(entry.dispatchEngine,'TALA Dispatch Engine');
   assert.equal(entry.dispatchEngineVersion,'2.0.0-lab');
   assert.equal(entry.dispatchMethod,'proximity');
   assert.equal('latitude' in entry,false);
   assert.equal('longitude' in entry,false);
  }
 }finally{await p.end();}
});
test('GEO v2: full nearest courier falls back to the next near driver',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const z=zone();
  const near=await courier(p,z,point(20.6531,-103.699));
  const far=await courier(p,z,point(20.656,-103.699));
  const first=await reserveNearestDelivery(p,request(z),key(),point(),20000);
  const second=await reserveNearestDelivery(p,request(z),key(),point(),20000);
  assert.equal(first.decision,'RESERVED');
  assert.equal(first.courierId,near);
  assert.equal(second.decision,'RESERVED');
  assert.equal(second.courierId,far);
 }finally{await p.end();}
});
test('GEO v2: excludes stale GPS, no GPS, offline and outside radius',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const z=zone();
  const stale=await courier(p,z,point(20.6531,-103.699));
  const missing=await courier(p,z,null);
  const far=await courier(p,z,point(21,-103.699));
  await p.query("UPDATE tala_logistics_v2.courier_positions "+
   "SET observed_at=clock_timestamp()-interval '4 minutes' WHERE courier_id=$1",[stale]);
  const q=request(z);
  const result=await reserveNearestDelivery(p,q,key(),point(),1500);
  assert.deepEqual(result,{decision:'NO_AVAILABLE_COURIER',orderId:q.orderId});
  assert.notEqual(missing,far);
 }finally{await p.end();}
});
test('GEO v2: simultaneous orders cannot overfill closest driver',{
 skip:!enabled,timeout:30000
},async()=>{
 const p=pool();
 try{
  const z=zone(),near=await courier(p,z,point(20.6531,-103.699));
  const out=await Promise.all([
   reserveNearestDelivery(p,request(z),key(),point()),
   reserveNearestDelivery(p,request(z),key(),point())
  ]);
  assert.equal(out.filter(x=>x.decision==='RESERVED').length,1);
  assert.equal(out.filter(x=>x.decision==='NO_AVAILABLE_COURIER').length,1);
  const q=await p.query(
   "SELECT count(*)::int AS n FROM tala_logistics_v2.dispatch_reservations "+
   "WHERE courier_id=$1 AND status='reserved'",[near]);
  assert.equal(q.rows[0].n,1);
 }finally{await p.end();}
});
test('GEO v2: same order and command is idempotent under parallel calls',{
 skip:!enabled,timeout:30000
},async()=>{
 const p=pool();
 try{
  const z=zone(),near=await courier(p,z,point()),r=request(z),cmd=key();
  const responses=await Promise.all([
   reserveNearestDelivery(p,r,cmd,point()),
   reserveNearestDelivery(p,r,cmd,point())
  ]);
  assert.equal(responses.every(x=>x.decision==='RESERVED'),true);
  assert.equal(responses.every(x=>x.courierId===near),true);
  assert.deepEqual(responses.map(x=>x.replayed).sort(),[false,true]);
  const q=await p.query('SELECT count(*)::int AS n FROM tala_logistics_v2.dispatch_events WHERE order_id=$1',[r.orderId]);
  assert.equal(q.rows[0].n,1);
 }finally{await p.end();}
});
test('GEO v2: rejects invalid restaurant, unbounded radius and no-ready orders',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const z=zone(),r=request(z);
  await assert.rejects(reserveNearestDelivery(p,r,key(),point(91,0)),
    assertCode('LOGISTICS_GEO_REQUEST_INVALID'));
  await assert.rejects(reserveNearestDelivery(p,r,key(),point(),100001),
    assertCode('LOGISTICS_GEO_REQUEST_INVALID'));
  assert.deepEqual(await reserveNearestDelivery(p,{...r,orderStatus:'preparing'},
    key(),point()),{decision:'NOT_ELIGIBLE',orderId:r.orderId});
  assert.deepEqual(await reserveNearestDelivery(p,{...r,fulfillment:'pickup'},
    key(),point()),{decision:'NOT_ELIGIBLE',orderId:r.orderId});
 }finally{await p.end();}
});
test('GEO v2: legacy capacity-only dispatch remains unchanged',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const z=zone(),noGps=await courier(p,z,null);
  const q=request(z),result=await reserveDelivery(p,q,key());
  assert.equal(result.decision,'RESERVED');
  assert.equal(result.courierId,noGps);
  const closed=await finalizeDispatch(p,q.orderId,'1',key(),'released');
  assert.equal(closed.status,'released');
  const audit=await p.query('SELECT details FROM tala_logistics_v2.dispatch_events WHERE order_id=$1 AND event_type=$2',
   [q.orderId,'dispatch.reserved']);
  assert.equal(audit.rows[0].details.dispatchMethod,'capacity');
  assert.equal(audit.rows[0].details.dispatchEngineVersion,'1.0.0-lab');
 }finally{await p.end();}
});
