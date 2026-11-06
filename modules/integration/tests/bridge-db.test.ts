import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {IntegrationError,type IntegrationEvent} from '../src/events.js';
import {publishEvent,claimDelivery,acknowledgeDelivery,rejectDelivery,
 readBridgeMetrics,deliverOnce} from '../src/bridge.js';

const url=process.env.INTEGRATION_CI_URL??'';
const enabled=/\/tala_integration_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
const occurred=()=>new Date(Math.floor(Date.now()/1000)*1000)
 .toISOString().replace('.000Z','Z');
const make=(kind:IntegrationEvent['kind'],merchantId=id(),
 orderId=id()):IntegrationEvent=>({
 schemaVersion:1,eventId:id(),source:
  kind==='orders.order_created'?'orders':
  kind==='restaurants.order_ready'?'restaurants':'logistics',
 kind,merchantId,orderId,occurredAt:occurred()
});
const rejected=(p:Promise<unknown>,code:string)=>assert.rejects(p,
 e=>e instanceof IntegrationError&&e.code===code);
test('M11 25 duplicate unpaid-order events store one fact but no notification deliveries',
 {skip:!enabled,timeout:80000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:28});
 try{
  const e=make('orders.order_created');
  const concurrent=await Promise.all(Array.from({length:25},()=>
   publishEvent(pool,{trustedHost:true,source:'orders'},e)));
  assert.equal(concurrent.filter(x=>!x.duplicate).length,1);
  assert.equal(concurrent.filter(x=>x.duplicate).length,24);
  const count=await pool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_integration_v2.events '+
   'WHERE event_id=$1::uuid',[e.eventId]);
  assert.equal(count.rows[0]?.n,1);
  const d=await pool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_integration_v2.deliveries '+
   'WHERE event_id=$1::uuid',[e.eventId]);
  assert.equal(d.rows[0]?.n,0,'unpaid order-created events must not fan out');
  await rejected(publishEvent(pool,{trustedHost:true,source:'orders'},
   {...e,merchantId:id()}),'M11_EVENT_CONFLICT');
  await rejected(publishEvent(pool,{trustedHost:false as true,source:'orders'},e),
   'M11_PUBLISHER_UNTRUSTED');
  await rejected(publishEvent(pool,{trustedHost:true,source:'logistics'},e),
   'M11_SOURCE_MISMATCH');
  await assert.rejects(pool.query('UPDATE tala_integration_v2.events '+
   "SET kind='restaurants.order_ready' WHERE event_id=$1::uuid",[e.eventId]),
   /M11_EVENT_IMMUTABLE/);
  // No notification delivery for a merely created, unpaid order.
 }finally{await pool.end();}
});
test('M11 routes the event to registered consumers, one lease per consumer',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:20});
 try{
  const merchantId=id(),orderId=id();
  const e=make('restaurants.order_ready',merchantId,orderId);
  const p=await publishEvent(pool,{trustedHost:true,source:'restaurants'},e);
  assert.equal(p.consumers,2);
  const claims=await Promise.all(Array.from({length:12},()=>
   claimDelivery(pool,'logistics')));
  const own=claims.filter(x=>x?.event.eventId===e.eventId);
  assert.equal(own.length,1);
  const c=own[0]!;
  await acknowledgeDelivery(pool,c);
  await rejected(acknowledgeDelivery(pool,c),'M11_STALE_LEASE');
  const noti=await deliverOnce(pool,'notifications',{
   handle:async(event,key)=>{
    assert.match(key,/\|notifications$/);
    assert.equal(event.source,'restaurants');
   }
  });
  assert.equal('delivered' in noti&&noti.delivered,true);
  const records=await pool.query<{consumer:string,state:string}>(
   'SELECT consumer,state FROM tala_integration_v2.deliveries '+
   'WHERE event_id=$1::uuid ORDER BY consumer',[e.eventId]);
  assert.deepEqual(records.rows,[
   {consumer:'logistics',state:'delivered'},
   {consumer:'notifications',state:'delivered'}
  ]);
 }finally{await pool.end();}
});
test('M11 expired lease redrives with new claim ID; stale worker cannot ACK',
 {skip:!enabled,timeout:80000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 try{
  const e=make('logistics.delivery_completed');
  await publishEvent(pool,{trustedHost:true,source:'logistics'},e);
  const old=await claimDelivery(pool,'analytics');
  assert.ok(old&&old.event.eventId===e.eventId);
  await pool.query('UPDATE tala_integration_v2.deliveries '+
   "SET lease_until=clock_timestamp()-interval '1 second' "+
   'WHERE event_id=$1::uuid AND consumer=$2',[e.eventId,'analytics']);
  const recovered=await claimDelivery(pool,'analytics');
  assert.ok(recovered);
  assert.notEqual(recovered.claimId,old.claimId);
  await rejected(acknowledgeDelivery(pool,old),'M11_STALE_LEASE');
  await acknowledgeDelivery(pool,recovered);
  const view=await readBridgeMetrics(pool,{canMonitorIntegration:true});
  assert.equal(view.commercialReady,false);
  assert.ok(view.counts.some(x=>x.consumer==='analytics'&&x.state==='delivered'));
  await rejected(readBridgeMetrics(pool,{}),'M11_FORBIDDEN');
 }finally{await pool.end();}
});
test('M11 repeated safe failures end in DLQ after exactly 3 attempts',
 {skip:!enabled,timeout:85000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 try{
  const e=make('restaurants.order_ready');
  await publishEvent(pool,{trustedHost:true,source:'restaurants'},e);
  for(let i=1;i<=3;i++){
   const claim=await claimDelivery(pool,'logistics');
   assert.ok(claim?.event.eventId===e.eventId);
   const outcome=await rejectDelivery(pool,claim);
   assert.equal(outcome.state,i===3?'dead':'pending');
   if(i<3)await pool.query('UPDATE tala_integration_v2.deliveries '+
    "SET next_attempt_at=clock_timestamp()-interval '1 second' "+
    'WHERE event_id=$1::uuid AND consumer=$2',
    [e.eventId,'logistics']);
  }
  const gone=await pool.query<{state:string,attempts:number}>(
   'SELECT state,attempts FROM tala_integration_v2.deliveries '+
   'WHERE event_id=$1::uuid AND consumer=$2',
   [e.eventId,'logistics']);
  assert.deepEqual(gone.rows,[{state:'dead',attempts:3}]);
  const claimed=await claimDelivery(pool,'logistics');
  assert.ok(claimed===null||claimed.event.eventId!==e.eventId);
 }finally{await pool.end();}
});
