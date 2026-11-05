import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createM5NotificationLabConsumer} from '../adapters/notifications-lab.js';
import {publishEvent,claimDelivery,acknowledgeDelivery,deliverOnce} from '../src/bridge.js';
import {IntegrationError,type IntegrationEvent} from '../src/events.js';
import {readInbox} from '../../notifications/src/store.js';
import {setRecipientPreference} from '../../notifications/src/recipients.js';

const bridgeUrl=process.env.INTEGRATION_CI_URL??'';
const notificationUrl=process.env.NOTIFICATIONS_CI_URL??'';
const enabled=bridgeUrl.includes('/tala_integration_v2_test')&&
 notificationUrl.includes('/tala_notifications_v2_test');
const id=()=>randomUUID();
const time=()=>new Date(Math.floor(Date.now()/1000)*1000)
 .toISOString().replace('.000Z','Z');

function event(kind:IntegrationEvent['kind'],orderId=id(),
 merchantId=id()):IntegrationEvent{
 const source=kind==='orders.order_created'?'orders':
  kind==='restaurants.order_ready'?'restaurants':'logistics';
 return {schemaVersion:1,eventId:id(),source,kind,merchantId,
  orderId,occurredAt:time()};
}
async function allowInboxOnly(pool:pg.Pool,recipientId:string){
 await setRecipientPreference(pool,{recipientId,app:'customer',
  category:'transactional',channel:'email',enabled:false});
 await setRecipientPreference(pool,{recipientId,app:'customer',
  category:'transactional',channel:'push',enabled:false});
}

test('M11 -> real M5: restaurant-ready and delivery become scoped customer inbox notices',
 {skip:!enabled,timeout:90000},async()=>{
 const bridgePool=new pg.Pool({connectionString:bridgeUrl,max:12});
 const notificationPool=new pg.Pool({connectionString:notificationUrl,max:12});
 const customerId=id(),merchantId=id(),orderId=id();
 const ready=event('restaurants.order_ready',orderId,merchantId);
 const delivered=event('logistics.delivery_completed',orderId,merchantId);
 const resolver=async(e:IntegrationEvent)=>({
  approved:true as const,sourceEventId:e.eventId,merchantId:e.merchantId,
  orderId:e.orderId,recipientId:customerId
 });
 const consumer=createM5NotificationLabConsumer({
  bridgePool,notificationPool,resolveTrustedRecipient:resolver
 });
 try{
  await allowInboxOnly(notificationPool,customerId);
  await publishEvent(bridgePool,{trustedHost:true,source:'restaurants'},ready);
  await publishEvent(bridgePool,{trustedHost:true,source:'logistics'},delivered);
  const a=await deliverOnce(bridgePool,'notifications',consumer,ready.eventId);
  const b=await deliverOnce(bridgePool,'notifications',consumer,delivered.eventId);
  assert.equal('delivered' in a&&a.delivered,true);
  assert.equal('delivered' in b&&b.delivered,true);
  const inbox=await readInbox(notificationPool,{recipientId:customerId,
   app:'customer'});
  assert.equal(inbox.items.length,2);
  assert.equal(inbox.unreadCount,2);
  assert.deepEqual(inbox.items.map(x=>x.eventType).sort(),
   ['order.delivered','order.ready']);
  assert.ok(inbox.items.every(x=>x.data.resourceId===orderId));
  assert.ok(inbox.items.every(x=>!Object.hasOwn(x,'customerEmail')));
  const foreign=await readInbox(notificationPool,{recipientId:id(),app:'customer'});
  assert.equal(foreign.items.length,0);
  const bound=await bridgePool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_integration_v2.notification_bindings '+
   'WHERE recipient_id=$1::uuid',[customerId]);
  assert.equal(bound.rows[0]?.n,2);
  const noNetwork=await notificationPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_notifications_v2.deliveries d '+
   'JOIN tala_notifications_v2.inbox i ON i.id=d.notification_id '+
   'WHERE i.recipient_id=$1::uuid',[customerId]);
  assert.equal(noNetwork.rows[0]?.n,0,
   'LAB no email or push provider work is scheduled in the test');
 }finally{await Promise.all([bridgePool.end(),notificationPool.end()]);}
});

test('M11 -> M5: replay after M5 commit never duplicates recipient receipt or inbox',
 {skip:!enabled,timeout:90000},async()=>{
 const bridgePool=new pg.Pool({connectionString:bridgeUrl,max:10});
 const notificationPool=new pg.Pool({connectionString:notificationUrl,max:10});
 const recipientId=id(),evt=event('logistics.delivery_completed');
 const consumer=createM5NotificationLabConsumer({
  bridgePool,notificationPool,
  resolveTrustedRecipient:async e=>({
   approved:true as const,sourceEventId:e.eventId,merchantId:e.merchantId,
   orderId:e.orderId,recipientId
  })
 });
 try{
  await allowInboxOnly(notificationPool,recipientId);
  await publishEvent(bridgePool,{trustedHost:true,source:'logistics'},evt);
  const claim=await claimDelivery(bridgePool,'notifications',evt.eventId);
  assert.equal(claim?.event.eventId,evt.eventId);
  assert.ok(claim);
  // M5 committed but M11 process crashed before it could ACK.
  await consumer.handle(claim.event,claim.event.eventId+'|notifications');
  await bridgePool.query('UPDATE tala_integration_v2.deliveries '+
   "SET lease_until=clock_timestamp()-interval '1 second' "+
   "WHERE event_id=$1::uuid AND consumer='notifications'",[evt.eventId]);
  const retry=await deliverOnce(bridgePool,'notifications',consumer,evt.eventId);
  assert.equal('delivered' in retry&&retry.delivered,true);
  await assert.rejects(acknowledgeDelivery(bridgePool,claim),
   e=>e instanceof IntegrationError&&e.code==='M11_STALE_LEASE');
  const inbox=await readInbox(notificationPool,{recipientId,app:'customer'});
  assert.equal(inbox.items.length,1);
  assert.equal(inbox.items[0]?.eventType,'order.delivered');
  const receipt=await notificationPool.query<{n:number}>(
   'SELECT count(*)::int AS n '+
   'FROM tala_notifications_v2.publication_receipts '+
   'WHERE source_event_id=$1::uuid',[evt.eventId]);
  assert.equal(receipt.rows[0]?.n,1);
  const binding=await bridgePool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_integration_v2.notification_bindings '+
   'WHERE event_id=$1::uuid',[evt.eventId]);
  assert.equal(binding.rows[0]?.n,1);
 }finally{await Promise.all([bridgePool.end(),notificationPool.end()]);}
});

test('M11 -> M5: recipient swap is denied even with a subsequently trusted resolver',
 {skip:!enabled,timeout:90000},async()=>{
 const bridgePool=new pg.Pool({connectionString:bridgeUrl,max:10});
 const notificationPool=new pg.Pool({connectionString:notificationUrl,max:10});
 const original=id(),impostor=id(),evt=event('restaurants.order_ready');
 try{
  await allowInboxOnly(notificationPool,original);
  await publishEvent(bridgePool,{trustedHost:true,source:'restaurants'},evt);
  const make=(recipientId:string)=>createM5NotificationLabConsumer({
   bridgePool,notificationPool,
   resolveTrustedRecipient:async e=>({
    approved:true as const,sourceEventId:e.eventId,merchantId:e.merchantId,
    orderId:e.orderId,recipientId
   })
  });
  const key=evt.eventId+'|notifications';
  await make(original).handle(evt,key);
  await assert.rejects(make(impostor).handle(evt,key),
   e=>e instanceof IntegrationError&&e.code==='M11_RECIPIENT_BINDING_CONFLICT');
  const foreign=await readInbox(notificationPool,{recipientId:impostor,
   app:'customer'});
  assert.equal(foreign.items.length,0);
  const sourceSpoof={...evt,merchantId:id()};
  await assert.rejects(make(original).handle(sourceSpoof,key),
   e=>e instanceof IntegrationError&&e.code==='M11_SOURCE_EVENT_MISMATCH');
  const proofMismatch=createM5NotificationLabConsumer({
   bridgePool,notificationPool,resolveTrustedRecipient:async e=>({
    approved:true as const,sourceEventId:id(),
    merchantId:e.merchantId,orderId:e.orderId,recipientId:impostor
   })
  });
  await assert.rejects(proofMismatch.handle(evt,key),
   e=>e instanceof IntegrationError&&e.code==='M11_RECIPIENT_UNVERIFIED');
  const originalInbox=await readInbox(notificationPool,{recipientId:original,
   app:'customer'});
  assert.equal(originalInbox.items.length,1);
 }finally{await Promise.all([bridgePool.end(),notificationPool.end()]);}
});

test('M11 -> M5: unpaid order-created event never becomes restaurant notification',
 {skip:!enabled,timeout:80000},async()=>{
 const bridgePool=new pg.Pool({connectionString:bridgeUrl,max:8});
 const notificationPool=new pg.Pool({connectionString:notificationUrl,max:8});
 const evt=event('orders.order_created');
 let resolverCalled=false;
 const consumer=createM5NotificationLabConsumer({
  bridgePool,notificationPool,
  resolveTrustedRecipient:async e=>{
   resolverCalled=true;
   return {approved:true as const,sourceEventId:e.eventId,
    merchantId:e.merchantId,orderId:e.orderId,recipientId:id()};
  }
 });
 try{
  const created=await publishEvent(bridgePool,{trustedHost:true,source:'orders'},evt);
  assert.equal(created.consumers,0,
   'do not even enqueue a customer/merchant notice before payment verification');
  await assert.rejects(consumer.handle(evt,evt.eventId+'|notifications'),
   e=>e instanceof IntegrationError&&
    e.code==='M11_NOTIFICATION_PAYMENT_UNVERIFIED');
  assert.equal(resolverCalled,false);
  const receipts=await notificationPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_notifications_v2.publication_receipts '+
   'WHERE source_event_id=$1::uuid',[evt.eventId]);
  assert.equal(receipts.rows[0]?.n,0);
  const bindings=await bridgePool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_integration_v2.notification_bindings '+
   'WHERE event_id=$1::uuid',[evt.eventId]);
  assert.equal(bindings.rows[0]?.n,0);
 }finally{await Promise.all([bridgePool.end(),notificationPool.end()]);}
});
