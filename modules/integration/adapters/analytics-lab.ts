/** M11 -> REAL M10 Analytics adapter for a logistics completion event.
 * LAB ONLY. The source module remains untouched and owns its DB.
 * The in-process test host holds an independent logistics HMAC TEST key.
 * For production the originating M2 must sign its own durable outbox event.
 */
import type {Pool} from 'pg';
import {IntegrationError,type IntegrationEvent} from '../src/events.js';
import {signAnalyticsEvent,type IssuerKeys} from '../../analytics/src/contract.js';
import {ingestAnalyticsEvent} from '../../analytics/src/analytics.js';

export function createAnalyticsLabConsumer(config:{
 analyticsPool:Pool,keys:IssuerKeys,kid:string
}):{
 handle:(event:IntegrationEvent,deliveryId:string)=>Promise<void>
}{
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 return Object.freeze({
  handle:async(event:IntegrationEvent,deliveryId:string):Promise<void>=>{
   if(process.env.NODE_ENV==='production')
    throw new IntegrationError('M11_COMMERCIAL_DISABLED');
   if(event.kind!=='logistics.delivery_completed'||
      event.source!=='logistics'||deliveryId!==event.eventId+'|analytics')
    throw new IntegrationError('M11_CONSUMER_KIND_INVALID');
   const raw=Buffer.from(JSON.stringify({
    eventId:event.eventId,kind:'delivery.completed',
    merchantId:event.merchantId,orderId:event.orderId,
    refundId:null,amountCents:0,occurredAt:event.occurredAt
   }));
   const signature=signAnalyticsEvent(raw,'logistics',config.kid,config.keys);
   // This invokes M10's OWN ingestion contract and DB guard, not its tables.
   await ingestAnalyticsEvent({pool:config.analyticsPool,keys:config.keys},{
    issuer:'logistics',kid:config.kid,raw,signature});
  }
 });
}
