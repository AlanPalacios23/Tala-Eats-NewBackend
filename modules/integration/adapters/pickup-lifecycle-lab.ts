/** LAB7 only — M1 pickup lifecycle and verified producer outbox transport.
 * M1's PostgreSQL transaction is the source of truth. Relay publishes only
 * events already committed in the authentic M1 outbox with matching audit.
 * No customer/merchant identifiers are trusted from request bodies.
 */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {readAuthenticatedProfile,readMyIdentityRole}
 from '../../users/src/auth.js';
import {resolveSession} from '../../../src/modules/orders/lab-auth.ts';
import {advanceMerchantOrder} from '../../../src/modules/orders/merchant-orders.ts';
import {issueBuyerHandoffPin,attestCash,finishCashOrder}
 from '../../../src/modules/orders/handoff.ts';
import {publishEvent} from '../src/bridge.js';
import {IntegrationError,validUuid,type IntegrationEvent}
 from '../src/events.js';
import {inspectM6StockHold} from '../m6-extension/reservations.js';
import type {CatalogLabConfig} from './catalog-checkout-lab.js';

export type PickupLabConfig=CatalogLabConfig;
type M1Order={
 id:string,restaurant_id:string,buyer_id:string,status:string,
 fulfillment:string,payment_method:string,payment_status:string,
 total_minor:string,version:string,price_snapshot:Record<string,unknown>
};
type ProducerEvent={
 event_key:string,event_type:string,created_utc:string,
 new_status:string,actor_role:string|null,
 data:Record<string,unknown>,payload:Record<string,unknown>
};
const guard=()=>{
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
};
async function poolDb(pool:Pool,expected:string){
 guard();
 const r=await pool.query<{name:string}>('SELECT current_database() AS name');
 if(r.rows[0]?.name!==expected)throw new IntegrationError('M11_LAB_ONLY');
}
export function m1OutboxEventUuid(key:string){
 if(!/^[0-9a-f]{64}$/.test(key))
  throw new IntegrationError('M11_SOURCE_EVENT_INVALID');
 const b=createHash('sha256').update('m11-m1-pickup-v1|'+key).digest();
 b[6]=(b[6]!&0x0f)|0x50;b[8]=(b[8]!&0x3f)|0x80;
 const x=b.subarray(0,16).toString('hex');
 return x.slice(0,8)+'-'+x.slice(8,12)+'-'+x.slice(12,16)+'-'+
  x.slice(16,20)+'-'+x.slice(20);
}
async function orderRow(pool:Pool,orderId:string):Promise<M1Order>{
 await poolDb(pool,'tala_core_v2_test');
 const r=await pool.query<M1Order>(
  'SELECT id,restaurant_id,buyer_id,status,fulfillment,payment_method,'+
  'payment_status,total_minor::text,version::text,price_snapshot '+
  'FROM tala_core_v2.orders WHERE id=$1::uuid',[validUuid(orderId)]);
 if(!r.rows[0])throw new IntegrationError('M11_ORDER_NOT_FOUND');
 if(r.rows[0].fulfillment!=='pickup'||r.rows[0].payment_method!=='cash')
  throw new IntegrationError('M11_PICKUP_CASH_ONLY');
 return r.rows[0];
}
async function verifyHold(config:PickupLabConfig,order:M1Order){
 await poolDb(config.integrationPool,'tala_integration_v2_test');
 const r=await config.integrationPool.query<{intent_id:string}>(
  'SELECT i.intent_id FROM tala_integration_v2.inventory_checkout_intents i '+
  'JOIN tala_integration_v2.branch_catalog_links m '+
  'ON m.m6_branch_id=i.branch_id AND m.m6_store_id=i.store_id '+
  'WHERE i.m1_order_id=$1::uuid AND i.buyer_m1_id=$2::uuid '+
  "AND i.state='confirmed' AND m.m1_restaurant_id=$3::uuid",
  [order.id,order.buyer_id,order.restaurant_id]);
 if(r.rows.length!==1)throw new IntegrationError('M11_CONFIRMED_HOLD_REQUIRED');
 const hold=await inspectM6StockHold(config.restaurantsPool,r.rows[0]!.intent_id);
 if(hold?.state!=='confirmed'||hold.orderId!==order.id)
  throw new IntegrationError('M11_CONFIRMED_HOLD_REQUIRED');
}
async function merchant(config:PickupLabConfig,token:string,order:M1Order){
 const actor=await resolveSession(config.ordersPool,token).catch(()=>null);
 if(!actor||actor.role!=='merchant')
  throw new IntegrationError('M11_MERCHANT_SESSION_REQUIRED');
 const r=await config.ordersPool.query(
  'SELECT 1 FROM tala_core_v2.restaurant_memberships '+
  'WHERE restaurant_id=$1::uuid AND member_id=$2::uuid AND is_active=true',
  [order.restaurant_id,actor.id]);
 if(!r.rowCount)throw new IntegrationError('M11_MERCHANT_NOT_AUTHORIZED');
 return validUuid(actor.id);
}
async function buyer(config:PickupLabConfig,token:string,order:M1Order){
 const user=await readAuthenticatedProfile(config.usersPool,{
  sessionToken:token,secret:config.usersPasswordPepper}).catch(()=>null);
 if(!user)throw new IntegrationError('M11_IDENTITY_NOT_AUTHENTICATED');
 const role=await readMyIdentityRole(config.usersPool,{
  sessionToken:token,secret:config.usersPasswordPepper}).catch(()=>null);
 if(role?.role!=='customer'||role.userId!==user.id)
  throw new IntegrationError('M11_CUSTOMER_ROLE_REQUIRED');
 const r=await config.integrationPool.query<{m1_customer_id:string}>(
  'SELECT l.m1_customer_id FROM tala_integration_v2.customer_identity_links l '+
  'WHERE l.m4_user_id=$1::uuid AND NOT EXISTS('+
  'SELECT 1 FROM tala_integration_v2.customer_link_revocations v '+
  'WHERE v.m4_user_id=l.m4_user_id)',[validUuid(user.id)]);
 if(r.rows[0]?.m1_customer_id!==order.buyer_id)
  throw new IntegrationError('M11_BUYER_NOT_AUTHORIZED');
 return order.buyer_id;
}
export async function advanceLabPickupMerchant(config:PickupLabConfig,input:{
 merchantM1SessionToken:string,orderId:string,
 target:'confirmed'|'preparing'|'ready',expectedVersion:string,
 commandKey:string
}){
 guard();
 const order=await orderRow(config.ordersPool,input.orderId);
 await verifyHold(config,order);
 const actorId=await merchant(config,input.merchantM1SessionToken,order);
 if(typeof input.expectedVersion!=='string'||!/^[1-9]\d{0,18}$/.test(input.expectedVersion))
  throw new IntegrationError('M11_VERSION_INVALID');
 const result=await advanceMerchantOrder(config.ordersPool,{
  actorId,orderId:order.id,target:input.target,
  commandKey:input.commandKey,expectedVersion:BigInt(input.expectedVersion)
 });
 return Object.freeze({...result,version:result.version.toString(),
  source:'m1_verified_merchant_lab' as const,
  outboxPending:input.target==='ready' as boolean,
  commercialReady:false as const});
}
export async function issueLabPickupPin(config:PickupLabConfig,input:{
 m4SessionToken:string,orderId:string
}){
 guard(); const order=await orderRow(config.ordersPool,input.orderId);
 await verifyHold(config,order);
 const id=await buyer(config,input.m4SessionToken,order);
 // Sensitive proof: caller MUST NOT log/echo to other users.
 return issueBuyerHandoffPin(config.ordersPool,id,order.id);
}
export async function attestLabPickupBuyerCash(config:PickupLabConfig,input:{
 m4SessionToken:string,orderId:string
}){
 guard();const order=await orderRow(config.ordersPool,input.orderId);
 await verifyHold(config,order);
 const id=await buyer(config,input.m4SessionToken,order);
 return attestCash(config.ordersPool,order.id,id,'customer');
}
export async function attestLabPickupMerchantCash(config:PickupLabConfig,input:{
 merchantM1SessionToken:string,orderId:string
}){
 guard();const order=await orderRow(config.ordersPool,input.orderId);
 await verifyHold(config,order);
 const id=await merchant(config,input.merchantM1SessionToken,order);
 return attestCash(config.ordersPool,order.id,id,'merchant');
}
export async function finishLabPickup(config:PickupLabConfig,input:{
 merchantM1SessionToken:string,orderId:string,
 commandKey:string,expectedVersion:string,pin:string
}){
 guard();const order=await orderRow(config.ordersPool,input.orderId);
 await verifyHold(config,order);
 const actorId=await merchant(config,input.merchantM1SessionToken,order);
 if(typeof input.expectedVersion!=='string'||!/^[1-9]\d{0,18}$/.test(input.expectedVersion))
  throw new IntegrationError('M11_VERSION_INVALID');
 const result=await finishCashOrder(config.ordersPool,{
  orderId:order.id,actorId,commandKey:input.commandKey,
  expectedVersion:BigInt(input.expectedVersion)
 },'merchant',input.pin);
 return Object.freeze({...result,version:result.version.toString(),
  outboxPending:true as const,paymentStatus:'paid_cash_in_custody' as const,
  custodySettled:false as const,commercialReady:false as const});
}
async function evidence(pool:Pool,order:M1Order):Promise<ProducerEvent[]>{
 const rows=await pool.query<ProducerEvent>(
  'SELECT b.event_key,b.event_type,'+
  "to_char(b.created_at AT TIME ZONE 'UTC',"+
  "'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_utc,"+
  'e.new_status,e.actor_role,e.data,b.payload '+
  'FROM tala_core_v2.outbox b JOIN tala_core_v2.order_events e '+
  'ON e.order_id=b.aggregate_id AND e.event_key=b.event_key '+
  'WHERE b.aggregate_id=$1::uuid AND ('+
  "(b.event_type='order.status.changed' AND e.new_status='ready') OR "+
  "b.event_type='order.delivered') "+
  'ORDER BY b.created_at,b.event_key',
  [order.id]);
 return rows.rows;
}
async function confirmPickupHandoff(pool:Pool,order:M1Order){
 if(order.status!=='delivered'||order.payment_status!=='paid')
  throw new IntegrationError('M11_CASH_HANDOFF_NOT_PROVEN');
 const r=await pool.query<{ok:boolean}>(
  'SELECT EXISTS(SELECT 1 FROM tala_core_v2.order_handoffs h '+
  'WHERE h.order_id=$1::uuid AND h.buyer_cash_ack_at IS NOT NULL '+
  'AND h.custodian_cash_ack_at IS NOT NULL AND h.pin_consumed_at IS NOT NULL '+
  "AND h.custodian_role='merchant' AND h.custodian_id IS NOT NULL "+
  'AND h.custody_settled_at IS NULL AND '+
  'h.cash_amount_minor=$2::bigint) AS ok',[order.id,order.total_minor]);
 if(!r.rows[0]?.ok)
  throw new IntegrationError('M11_CASH_HANDOFF_NOT_PROVEN');
}
/** Verify the original event in M1 DB before publishing to M11. */
export async function verifiedM1PickupEvents(config:PickupLabConfig,
 orderId:string):Promise<ReadonlyArray<IntegrationEvent>>{
 guard();
 const order=await orderRow(config.ordersPool,orderId);
 await verifyHold(config,order);
 const source=await evidence(config.ordersPool,order);
 const events:IntegrationEvent[]=[];
 for(const e of source){
  const ready=e.event_type==='order.status.changed'&&
   e.new_status==='ready'&&e.actor_role==='merchant'&&
   e.payload?.to==='ready'&&e.payload?.orderId===order.id;
  const complete=e.event_type==='order.delivered'&&
   e.new_status==='delivered'&&e.actor_role==='merchant'&&
   e.payload?.to==='delivered'&&e.payload?.orderId===order.id&&
   e.data?.pinVerified===true&&e.data?.buyerAttested===true&&
   e.data?.custodianAttested===true&&e.data?.custodySettled===false&&
   String(e.data?.cashAmountMinor)===order.total_minor;
  if(!ready&&!complete)continue;
  if(complete)await confirmPickupHandoff(config.ordersPool,order);
  const kind=ready?'orders.pickup_ready':'orders.pickup_completed';
  events.push(Object.freeze({schemaVersion:1,eventId:m1OutboxEventUuid(e.event_key),
   source:'orders',kind,merchantId:order.restaurant_id,
   orderId:order.id,occurredAt:e.created_utc}));
 }
 return Object.freeze(events);
}
export async function relayVerifiedM1PickupOutbox(config:PickupLabConfig,
 host:{authenticated?:boolean,canRelayM1Outbox?:boolean},
 orderId:string){
 guard();
 if(host?.authenticated!==true||host.canRelayM1Outbox!==true)
  throw new IntegrationError('M11_OUTBOX_RELAY_FORBIDDEN');
 await poolDb(config.integrationPool,'tala_integration_v2_test');
 const events=await verifiedM1PickupEvents(config,validUuid(orderId));
 const receipts=[];
 for(const event of events){
  receipts.push(await publishEvent(config.integrationPool,{
   trustedHost:true,source:'orders'
  },event));
 }
 return Object.freeze({orderId:validUuid(orderId),
  receipts:Object.freeze(receipts),commercialReady:false as const});
}
export async function proveLabPickupCashDelivery(config:PickupLabConfig,
 orderId:string){
 const order=await orderRow(config.ordersPool,orderId);
 await verifyHold(config,order);
 await confirmPickupHandoff(config.ordersPool,order);
 return order;
}
