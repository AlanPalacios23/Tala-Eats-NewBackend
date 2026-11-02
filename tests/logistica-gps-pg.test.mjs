import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {enrollCourier,approveCourier,setCourierOnline,
 recordCourierPosition,listNearbyCouriers,LogisticsError,reserveDelivery}
 from '../src/modules/modulo-2-logistica/index.ts';
const db=process.env.PG_CI_URL??'';
const enabled=(()=>{try{const u=new URL(db);return u.pathname==='/tala_core_v2_test'
  &&['127.0.0.1','localhost'].includes(u.hostname)}catch{return false}})();
const pool=()=>new Pool({connectionString:db,max:8,connectionTimeoutMillis:3000});
const point=(latitude=20.653,longitude=-103.699)=>({latitude,longitude});
const error=code=>e=>e instanceof LogisticsError&&e.code===code;
async function driver(p,zone,position=point(),capacity=1){
 const id=randomUUID();
 await enrollCourier(p,id,zone,capacity);
 await approveCourier(p,id,true);
 await setCourierOnline(p,id,true);
 if(position)await recordCourierPosition(p,id,position,10);
 return id;
}
const z=()=> 'zone_'+randomUUID().slice(0,12);

test('LAB GPS: schema created only in logistics, not in orders',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const q=await p.query(
   "SELECT to_regclass('tala_logistics_v2.courier_positions') IS NOT NULL AS gps,"+
   " to_regclass('tala_core_v2.courier_positions') IS NULL AS isolated");
  assert.deepEqual(q.rows[0],{gps:true,isolated:true});
 }finally{await p.end();}
});
test('LAB GPS: only approved online courier may send a fix',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const id=randomUUID(),zone=z();
  await enrollCourier(p,id,zone,1);
  await assert.rejects(recordCourierPosition(p,id,point(),10),
   error('LOGISTICS_GPS_COURIER_UNAVAILABLE'));
  await approveCourier(p,id,true);
  await assert.rejects(recordCourierPosition(p,id,point(),10),
   error('LOGISTICS_GPS_COURIER_UNAVAILABLE'));
  await setCourierOnline(p,id,true);
  await recordCourierPosition(p,id,point(),10);
  const q=await p.query(
   'SELECT count(*)::int AS count FROM tala_logistics_v2.courier_positions WHERE courier_id=$1',[id]);
  assert.equal(q.rows[0].count,1);
 }finally{await p.end();}
});
test('LAB GPS: coordinate and accuracy input rejected before SQL writes',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const id=await driver(p,z(),null);
  for(const [location,accuracy] of [
   [point(91,-103),10],[point(20,181),10],
   [point(NaN,0),10],[point(),101],[point(),-1],
   [point(),Infinity]
  ])await assert.rejects(recordCourierPosition(p,id,location,accuracy),
   error('LOGISTICS_GPS_INVALID'));
  const q=await p.query(
   'SELECT count(*)::int AS n FROM tala_logistics_v2.courier_positions WHERE courier_id=$1',[id]);
  assert.equal(q.rows[0].n,0);
 }finally{await p.end();}
});
test('LAB GPS: update overwrites same row; no trace history',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const id=await driver(p,z());
  await recordCourierPosition(p,id,point(20.654,-103.700),8);
  const q=await p.query(
   'SELECT latitude,longitude,accuracy_m FROM tala_logistics_v2.courier_positions WHERE courier_id=$1',[id]);
  assert.equal(q.rowCount,1);
  assert.equal(q.rows[0].latitude,20.654);
  assert.equal(q.rows[0].longitude,-103.700);
  assert.equal(q.rows[0].accuracy_m,8);
 }finally{await p.end();}
});
test('LAB GPS: offline or revoked courier GPS is purged automatically',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const zone=z(),a=await driver(p,zone),b=await driver(p,zone);
  await setCourierOnline(p,a,false);
  await approveCourier(p,b,false);
  for(const id of [a,b]){
   const q=await p.query(
    'SELECT count(*)::int AS n FROM tala_logistics_v2.courier_positions WHERE courier_id=$1',[id]);
   assert.equal(q.rows[0].n,0);
  }
 }finally{await p.end();}
});
test('LAB GPS: near drivers sorted by straight distance without revealing coordinates',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const zone=z();
  const far=await driver(p,zone,point(20.660,-103.699));
  const near=await driver(p,zone,point(20.654,-103.699));
  await driver(p,z(),point(20.653,-103.699));
  const got=await listNearbyCouriers(p,zone,point());
  assert.deepEqual(got.map(x=>x.courierId),[near,far]);
  assert.ok(got[0].distanceMeters<got[1].distanceMeters);
  assert.ok(got[0].distanceMeters>50&&got[0].distanceMeters<150);
  for(const item of got){
   assert.deepEqual(Object.keys(item).sort(),
    ['courierId','distanceMeters','activeDeliveries',
     'remainingCapacity','positionAgeSeconds'].sort());
   assert.equal('latitude' in item,false);
   assert.equal('longitude' in item,false);
  }
 }finally{await p.end();}
});
test('LAB GPS: stale location, stale presence and fully loaded drivers excluded',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  const zone=z(),stale=await driver(p,zone),busy=await driver(p,zone),
   missing=await driver(p,zone,null),oldHeartbeat=await driver(p,zone);
  await p.query("UPDATE tala_logistics_v2.courier_positions "+
   "SET observed_at=clock_timestamp()-interval '3 minutes' WHERE courier_id=$1",
   [stale]);
  await p.query("UPDATE tala_logistics_v2.couriers "+
   "SET last_seen_at=clock_timestamp()-interval '3 minutes' WHERE id=$1",
   [oldHeartbeat]);
  const orderId=randomUUID(),restaurantId=randomUUID();
  const res=await reserveDelivery(p,{
   orderId,restaurantId,deliveryZone:zone,fulfillment:'delivery',orderStatus:'ready'
  },'geo-test-'+randomUUID());
  assert.equal(res.decision,'RESERVED');
  // ReserveDelivery is still v1 and may select a driver lacking GPS.
  // Make busy explicitly full without assuming which courier was reserved.
  await p.query("INSERT INTO tala_logistics_v2.dispatch_reservations "+
   "(order_id,restaurant_id,zone,courier_id,status) VALUES($1,$2,$3,$4,'reserved')",
   [randomUUID(),restaurantId,zone,busy]);
  const got=await listNearbyCouriers(p,zone,point());
  assert.equal(got.some(x=>x.courierId===stale),false);
  assert.equal(got.some(x=>x.courierId===busy),false);
  assert.equal(got.some(x=>x.courierId===missing),false);
  assert.equal(got.some(x=>x.courierId===oldHeartbeat),false);
 }finally{await p.end();}
});
test('LAB GPS: query rejects bad zone, bad point and unsafe radius',{
 skip:!enabled
},async()=>{
 const p=pool();
 try{
  await assert.rejects(listNearbyCouriers(p,'../',point()),
   error('LOGISTICS_GEO_QUERY_INVALID'));
  await assert.rejects(listNearbyCouriers(p,z(),point(91,2)),
   error('LOGISTICS_GEO_QUERY_INVALID'));
  await assert.rejects(listNearbyCouriers(p,z(),point(),100001),
   error('LOGISTICS_GEO_QUERY_INVALID'));
 }finally{await p.end();}
});
