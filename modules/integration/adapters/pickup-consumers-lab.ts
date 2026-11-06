/** M11 LAB7 authentic consumers for M1 cash pickup outbox facts.
 * M5 inbox, M10 completed-order analytics and M3 HELD lab journal only.
 * M8 Stripe payments remain a separate production blocker: M1 currently
 * implements CASH checkout only. Never treat cash custody as PSP settlement.
 */
import type {Pool} from 'pg';
import {signAnalyticsEvent,type IssuerKeys}
 from '../../analytics/src/contract.js';
import {ingestAnalyticsEvent}
 from '../../analytics/src/analytics.js';
import type {NotificationRecipientResolver}
 from './notifications-lab.js';
import {IntegrationError,type IntegrationEvent,validUuid}
 from '../src/events.js';
import {proveLabPickupCashDelivery,verifiedM1PickupEvents,
 type PickupLabConfig} from './pickup-lifecycle-lab.js';
// M3 is a JavaScript-only native ESM module with its own runtime contract.
import {recordLabHeldAllocation,readMerchantFinancialBalance}
 // @ts-expect-error M3 intentionally ships .mjs without TS declarations
 from '../../finance/src/store.mjs';

const check=()=>{
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
};
async function gatedDb(pool:Pool,db:string){
 check();
 const r=await pool.query<{name:string}>('SELECT current_database() AS name');
 if(r.rows[0]?.name!==db)throw new IntegrationError('M11_LAB_ONLY');
}
async function isProducerFact(config:PickupLabConfig,event:IntegrationEvent){
 if(event.source!=='orders'||![
  'orders.pickup_ready','orders.pickup_completed'].includes(event.kind))
  throw new IntegrationError('M11_PRODUCER_KIND_FORBIDDEN');
 const evidence=await verifiedM1PickupEvents(config,event.orderId);
 const matching=evidence.find(x=>x.eventId===event.eventId);
 if(!matching||matching.kind!==event.kind||
  matching.merchantId!==event.merchantId||
  matching.occurredAt!==event.occurredAt)
  throw new IntegrationError('M11_OUTBOX_PROOF_MISSING');
}
/** The recipient is the M4 identity explicitly linked to M1's buyer.
 * Neither a storefront event nor a caller may pick an arbitrary user.
 */
export function createRealM1PickupRecipientResolver(
 config:PickupLabConfig):NotificationRecipientResolver{
 check();
 return async event=>{
  check();
  if(event.kind!=='orders.pickup_ready'&&
     event.kind!=='orders.pickup_completed')return null;
  await gatedDb(config.integrationPool,'tala_integration_v2_test');
  await isProducerFact(config,event);
  const order=await config.ordersPool.query<{
   buyer_id:string,restaurant_id:string}>(
   'SELECT buyer_id,restaurant_id FROM tala_core_v2.orders '+
   'WHERE id=$1::uuid',[event.orderId]);
  if(order.rows[0]?.restaurant_id!==event.merchantId)
   throw new IntegrationError('M11_MERCHANT_SOURCE_MISMATCH');
  const r=await config.integrationPool.query<{m4_user_id:string}>(
   'SELECT l.m4_user_id FROM tala_integration_v2.customer_identity_links l '+
   'WHERE l.m1_customer_id=$1::uuid AND NOT EXISTS('+
   'SELECT 1 FROM tala_integration_v2.customer_link_revocations v '+
   'WHERE v.m4_user_id=l.m4_user_id)',[order.rows[0]!.buyer_id]);
  if(!r.rows[0])throw new IntegrationError('M11_RECIPIENT_UNVERIFIED');
  return Object.freeze({approved:true as const,
   sourceEventId:event.eventId,merchantId:event.merchantId,
   orderId:event.orderId,recipientId:r.rows[0].m4_user_id});
 };
}
/** Actual M10 signed order.completed event. This counts completed pickup GMV
 * only; no Stripe payment fact nor logistic delivery is invented.
 */
export function createM1PickupAnalyticsLabConsumer(config:{
 pickup:PickupLabConfig,analyticsPool:Pool,
 keys:IssuerKeys,kid:string
}){
 check();
 return Object.freeze({handle:async(event:IntegrationEvent,deliveryId:string)=>{
  check();
  if(event.kind!=='orders.pickup_completed'||event.source!=='orders'||
     deliveryId!==event.eventId+'|analytics')
   throw new IntegrationError('M11_ANALYTICS_KIND_INVALID');
  await gatedDb(config.analyticsPool,'tala_analytics_v2_test');
  await isProducerFact(config.pickup,event);
  const order=await proveLabPickupCashDelivery(config.pickup,event.orderId);
  if(order.restaurant_id!==event.merchantId||
     !/^[1-9][0-9]*$/.test(order.total_minor)||
     Number(order.total_minor)>100_000_000)
   throw new IntegrationError('M11_ORDER_AMOUNT_INVALID');
  const raw=Buffer.from(JSON.stringify({
   eventId:event.eventId,kind:'order.completed',
   merchantId:event.merchantId,orderId:event.orderId,
   refundId:null,amountCents:Number(order.total_minor),
   occurredAt:event.occurredAt
  }));
  const signature=signAnalyticsEvent(raw,'orders',config.kid,config.keys);
  await ingestAnalyticsEvent({pool:config.analyticsPool,keys:config.keys},{
   issuer:'orders',kid:config.kid,raw,signature});
 }});
}
export async function recordRealM1PickupHeldFinance(config:{
 pickup:PickupLabConfig,financePool:Pool
},trusted:{authenticated?:boolean,canRecordHeldFinance?:boolean},
 orderId:string){
 check();
 if(trusted?.authenticated!==true||trusted.canRecordHeldFinance!==true)
  throw new IntegrationError('M11_FINANCE_FORBIDDEN');
 await gatedDb(config.financePool,'tala_finance_v2_test');
 const order=await proveLabPickupCashDelivery(config.pickup,validUuid(orderId));
 // Cross-check a genuine M1 source outbox with verified PIN and BOTH cash
 // acknowledgements, rather than a caller-supplied amount or JSON snapshot.
 const real=await verifiedM1PickupEvents(config.pickup,order.id);
 if(!real.some(x=>x.kind==='orders.pickup_completed'))
  throw new IntegrationError('M11_CASH_HANDOFF_NOT_PROVEN');
 const keys=['itemsMinor','merchantCommissionMinor','merchantPayableMinor',
  'serviceFeeMinor','deliveryFeeMinor','driverPayableMinor','tipMinor',
  'totalMinor','platformGrossMinor'] as const;
 const original=order.price_snapshot;
 if(!original||original.policyVersion!=='pilot-2026-11-v3-17pct-7pct-uncapped'||
    original.totalMinor!==order.total_minor||order.fulfillment!=='pickup')
  throw new IntegrationError('M11_FINANCE_SNAPSHOT_INVALID');
 const snapshot:Record<string,unknown>={
  currency:'MXN',policyVersion:original.policyVersion,
  fulfillment:order.fulfillment
 };
 for(const name of keys){
  if(typeof original[name]!=='string'||!/^(0|[1-9][0-9]*)$/.test(
      original[name] as string))
   throw new IntegrationError('M11_FINANCE_SNAPSHOT_INVALID');
  snapshot[name]=original[name];
 }
 const ledger=await recordLabHeldAllocation(config.financePool,{
  orderId:order.id,restaurantId:order.restaurant_id,
  snapshot,commandKey:'m11-pickup-held-'+order.id
 });
 const balance=await readMerchantFinancialBalance(config.financePool,
  order.restaurant_id);
 return Object.freeze({journalId:ledger.journalId,orderId:order.id,
  replayed:ledger.replayed,merchantPendingMinor:balance.pendingMinor,
  availableMinor:'0' as const,withdrawable:false as const,
  cashCustodySettled:false as const,externalTransfersEnabled:false as const,
  policyApproved:false as const,commercialReady:false as const});
}
