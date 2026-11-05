/** M10: small, privacy-minimized, server-issued domain-event contract.
 * No PII, client tracking, GPS, financial ledger, or Stripe credentials.
 */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

export class AnalyticsError extends Error{
 constructor(readonly code:string){super(code);this.name='AnalyticsError';}
}
export const EVENT_ISSUERS={
 'order.completed':'orders',
 'order.canceled':'orders',
 'payment.confirmed':'payments',
 'refund.confirmed':'payments',
 'delivery.completed':'logistics'
} as const;
export type EventKind=keyof typeof EVENT_ISSUERS;
export type Issuer='orders'|'payments'|'logistics';
export type AnalyticsEvent={
 eventId:string,kind:EventKind,merchantId:string,orderId:string,
 refundId:string|null,amountCents:number,occurredAt:string
};
export type IssuerKeys=Readonly<Record<Issuer,Readonly<Record<string,Buffer>>>>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KID=/^[a-z][a-z0-9_-]{2,31}$/;
const FIELDS=['eventId','kind','merchantId','orderId','refundId',
 'amountCents','occurredAt'] as const;
export function uuid(value:unknown):string{
 if(typeof value!=='string'||!UUID.test(value))
  throw new AnalyticsError('M10_UUID_INVALID');
 return value.toLowerCase();
}
export function validEvent(raw:unknown,now=Date.now()):AnalyticsEvent{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))
  throw new AnalyticsError('M10_EVENT_INVALID');
 const o=raw as Record<string,unknown>;
 if(Object.keys(o).length!==FIELDS.length||
  FIELDS.some(k=>!Object.hasOwn(o,k))||
  Object.keys(o).some(k=>!FIELDS.includes(k as typeof FIELDS[number]))||
  typeof o.kind!=='string'||!Object.hasOwn(EVENT_ISSUERS,o.kind))
  throw new AnalyticsError('M10_EVENT_INVALID');
 try{uuid(o.eventId);uuid(o.orderId);uuid(o.merchantId);
  if(o.refundId!==null)uuid(o.refundId);
 }catch{throw new AnalyticsError('M10_EVENT_INVALID');}
 const kind=o.kind as EventKind;
 if((kind==='refund.confirmed')!==(o.refundId!==null)||
   typeof o.amountCents!=='number'||
   !Number.isSafeInteger(o.amountCents)||
   o.amountCents<0||o.amountCents>100_000_000)
  throw new AnalyticsError('M10_EVENT_INVALID');
 if((kind==='order.canceled'||kind==='delivery.completed')?
     o.amountCents!==0:o.amountCents===0)
  throw new AnalyticsError('M10_EVENT_INVALID');
 if(typeof o.occurredAt!=='string'||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(o.occurredAt))
  throw new AnalyticsError('M10_EVENT_TIME_INVALID');
 const at=Date.parse(o.occurredAt);
 if(!Number.isFinite(at)||new Date(at).toISOString()!==
    o.occurredAt.slice(0,-1)+'.000Z')
  throw new AnalyticsError('M10_EVENT_TIME_INVALID');
 if(!Number.isSafeInteger(now)||at>now+300_000||at<now-90*86_400_000)
  throw new AnalyticsError('M10_EVENT_OUT_OF_WINDOW');
 return {
  eventId:uuid(o.eventId),kind,merchantId:uuid(o.merchantId),
  orderId:uuid(o.orderId),
  refundId:o.refundId===null?null:uuid(o.refundId),
  amountCents:o.amountCents,occurredAt:o.occurredAt
 };
}
function secret(keys:IssuerKeys,issuer:Issuer,kid:string):Buffer{
 if(!KID.test(kid)||!Object.hasOwn(keys,issuer)||
  !Object.hasOwn(keys[issuer],kid))throw new AnalyticsError('M10_ISSUER_UNTRUSTED');
 const key=keys[issuer][kid];
 if(!Buffer.isBuffer(key)||key.length<32)
  throw new AnalyticsError('M10_KEY_INVALID');
 return key;
}
function signedBytes(issuer:Issuer,kid:string,t:string,body:Buffer){
 return Buffer.concat([Buffer.from(issuer+'.'+kid+'.'+t+'.'),body]);
}
export function signAnalyticsEvent(body:Buffer,issuer:Issuer,kid:string,
 keys:IssuerKeys,t=Math.floor(Date.now()/1000)):string{
 // Trusted test/host helper only. Never provide a public signing endpoint.
 const key=secret(keys,issuer,kid);
 if(!Buffer.isBuffer(body)||body.length===0||body.length>8192||
   !Number.isSafeInteger(t))
  throw new AnalyticsError('M10_PAYLOAD_INVALID');
 return 't='+t+',v1='+createHmac('sha256',key)
  .update(signedBytes(issuer,kid,String(t),body)).digest('hex');
}
export function verifySignedEvent(raw:Buffer,issuer:Issuer,kid:string,
 header:string,keys:IssuerKeys,now=Date.now()):{
 event:AnalyticsEvent,hash:string
}{
 if(!Buffer.isBuffer(raw)||raw.length<2||raw.length>8192)
  throw new AnalyticsError('M10_PAYLOAD_INVALID');
 if(typeof header!=='string'||header.length>512||
   !/^t=\d{10},v1=[a-f0-9]{64}$/.test(header)||
   !Number.isSafeInteger(now))
  throw new AnalyticsError('M10_SIGNATURE_INVALID');
 const [partTime,partSig]=header.split(',');
 const timestamp=partTime!.slice(2),provided=Buffer.from(partSig!.slice(3),'hex');
 if(Math.abs(Math.floor(now/1000)-Number(timestamp))>300)
  throw new AnalyticsError('M10_SIGNATURE_EXPIRED');
 const expected=createHmac('sha256',secret(keys,issuer,kid))
  .update(signedBytes(issuer,kid,timestamp,raw)).digest();
 if(provided.length!==expected.length||!timingSafeEqual(provided,expected))
  throw new AnalyticsError('M10_SIGNATURE_INVALID');
 let obj:unknown;
 try{obj=JSON.parse(raw.toString('utf8'))}catch{
  throw new AnalyticsError('M10_EVENT_INVALID');
 }
 const event=validEvent(obj,now);
 if(EVENT_ISSUERS[event.kind]!==issuer)
  throw new AnalyticsError('M10_ISSUER_SCOPE_INVALID');
 return {event,hash:createHash('sha256').update(raw).digest('hex')};
}
