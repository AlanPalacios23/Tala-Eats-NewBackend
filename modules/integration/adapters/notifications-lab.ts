/** M11 -> real M5 delivery adapter, isolated LAB3 only.
 * Recipient identity is resolved by a trusted host (future M1/M4 bindings)
 * and persisted immutably BEFORE crossing the M5 database boundary.
 * An order-created event NEVER means paid: restaurant new-order alert is
 * explicitly denied until an authenticated verified-payment fact exists.
 */
import type {Pool} from 'pg';
import {publishNotification} from '../../notifications/src/store.js';
import type {PublishInput} from '../../notifications/src/domain.js';
import {IntegrationError,validUuid,
 type IntegrationEvent} from '../src/events.js';

export type TrustedRecipientBinding={
 approved:true,sourceEventId:string,merchantId:string,orderId:string,
 recipientId:string
};
export type NotificationRecipientResolver=(e:IntegrationEvent)=>
 Promise<TrustedRecipientBinding|null>;

type NotificationTarget=Pick<PublishInput,'app'|'eventType'>;
function notificationTarget(event:IntegrationEvent):NotificationTarget{
 if(event.kind==='orders.pickup_ready'&&event.source==='orders')
  return {app:'customer',eventType:'order.ready'};
 if(event.kind==='orders.pickup_completed'&&event.source==='orders')
  return {app:'customer',eventType:'order.delivered'};
 if(event.kind==='restaurants.order_ready'&&event.source==='restaurants')
  return {app:'customer',eventType:'order.ready'};
 if(event.kind==='logistics.delivery_completed'&&event.source==='logistics')
  return {app:'customer',eventType:'order.delivered'};
 if(event.kind==='orders.order_created')
  throw new IntegrationError('M11_NOTIFICATION_PAYMENT_UNVERIFIED');
 throw new IntegrationError('M11_CONSUMER_KIND_INVALID');
}

async function bindRecipient(pool:Pool,event:IntegrationEvent,
 recipientId:string,target:NotificationTarget){
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query("SET LOCAL statement_timeout='12000ms'");
  await c.query("SET LOCAL lock_timeout='3000ms'");
  const db=await c.query<{name:string}>('SELECT current_database() AS name');
  if(!['tala_integration_v2_test','tala_integration_v2_lab']
    .includes(db.rows[0]?.name??''))
   throw new IntegrationError('M11_LAB_ONLY');

  // Separate from lease lock: direct simultaneous adapter calls must not
  // attach two identities to the same event on a race.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,2049))',
   [event.eventId]);
  const source=await c.query<{source:string,kind:string,
   merchant_id:string,order_id:string}>(
   'SELECT source,kind,merchant_id,order_id FROM tala_integration_v2.events '+
   'WHERE event_id=$1::uuid FOR SHARE',[event.eventId]);
  const original=source.rows[0];
  if(!original||original.kind!==event.kind||original.source!==event.source||
     original.merchant_id!==event.merchantId||
     original.order_id!==event.orderId)
   throw new IntegrationError('M11_SOURCE_EVENT_MISMATCH');

  await c.query(
   'INSERT INTO tala_integration_v2.notification_bindings '+
   '(event_id,recipient_id,app,event_type) VALUES($1::uuid,$2::uuid,$3,$4) '+
   'ON CONFLICT(event_id) DO NOTHING',
   [event.eventId,recipientId,target.app,target.eventType]);
  const bound=await c.query<{recipient_id:string,app:string,event_type:string}>(
   'SELECT recipient_id,app,event_type FROM '+
   'tala_integration_v2.notification_bindings WHERE event_id=$1::uuid',
   [event.eventId]);
  if(bound.rows[0]?.recipient_id!==recipientId||
     bound.rows[0]?.app!==target.app||
     bound.rows[0]?.event_type!==target.eventType)
   throw new IntegrationError('M11_RECIPIENT_BINDING_CONFLICT');
  await c.query('COMMIT');
 }catch(err){
  await c.query('ROLLBACK').catch(()=>{});
  throw err;
 }finally{c.release();}
}

export function createM5NotificationLabConsumer(config:{
 bridgePool:Pool,notificationPool:Pool,
 resolveTrustedRecipient:NotificationRecipientResolver
}){
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 if(!config||typeof config.resolveTrustedRecipient!=='function')
  throw new IntegrationError('M11_RECIPIENT_RESOLVER_REQUIRED');
 return Object.freeze({
  handle:async(event:IntegrationEvent,deliveryId:string):Promise<void>=>{
   if(process.env.NODE_ENV==='production')
    throw new IntegrationError('M11_COMMERCIAL_DISABLED');
   if(deliveryId!==event.eventId+'|notifications')
    throw new IntegrationError('M11_DELIVERY_KEY_INVALID');
   const target=notificationTarget(event);
   const proof=await config.resolveTrustedRecipient(event);
   if(!proof||proof.approved!==true||
     proof.sourceEventId!==event.eventId||
     proof.merchantId!==event.merchantId||
     proof.orderId!==event.orderId)
    throw new IntegrationError('M11_RECIPIENT_UNVERIFIED');
   const recipientId=validUuid(proof.recipientId);
   await bindRecipient(config.bridgePool,event,recipientId,target);
   await publishNotification(config.notificationPool,{
    sourceEventId:event.eventId,recipientId,
    app:target.app,eventType:target.eventType,resourceId:event.orderId
   });
  }
 });
}
