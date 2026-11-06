/** M8 LAB signed mock-provider callback. NEVER an actual Stripe adapter.
 * Signature authenticates a simulated lab key only, not bank settlement.
 */
import {createHmac,timingSafeEqual} from 'node:crypto';
import type {Pool} from 'pg';
import {PaymentError,uuid,amount,currency,assertKeys,digest} from './domain.js';
import {tx} from './db.js';

const KINDS=['payment.succeeded','payment.failed','payment.canceled',
 'refund.succeeded','refund.failed'] as const;
type Kind=typeof KINDS[number];
type Event={eventId:string,kind:Kind,paymentId:string,refundId?:string,
 amountCents:number,currency:'MXN',providerRef?:string};

function validateEvent(raw:Buffer):Event{
 let decoded:unknown;
 try{decoded=JSON.parse(raw.toString('utf8'));}catch{
  throw new PaymentError('M8_WEBHOOK_INVALID');
 }
 assertKeys(decoded,['eventId','kind','paymentId','refundId',
  'amountCents','currency','providerRef']);
 const v=decoded as Record<string,unknown>;
 if(!KINDS.includes(v.kind as Kind))
  throw new PaymentError('M8_EVENT_KIND_INVALID');
 const kind=v.kind as Kind;
 const refund=kind.startsWith('refund.');
 if(refund!==('refundId' in v))
  throw new PaymentError('M8_EVENT_SCHEMA_INVALID');
 const eventId=uuid(v.eventId),paymentId=uuid(v.paymentId),
  refundId=refund?uuid(v.refundId):undefined;
 const amountCents=amount(v.amountCents),unit=currency(v.currency);
 const requiresRef=kind==='payment.succeeded'||kind==='refund.succeeded';
 if(requiresRef!==(typeof v.providerRef==='string'))
  throw new PaymentError('M8_EVENT_SCHEMA_INVALID');
 const providerRef=requiresRef?v.providerRef as string:undefined;
 if(providerRef&&!/^lab_[a-z0-9_]{6,75}$/.test(providerRef))
  throw new PaymentError('M8_PROVIDER_REF_INVALID');
 return {eventId,kind,paymentId,...(refundId?{refundId}:{}),
  amountCents,currency:unit,...(providerRef?{providerRef}:{})};
}
export function verifyLabSignature(secret:Buffer,raw:Buffer,
 timestamp:string,header:string,now=Date.now()){
 if(!Buffer.isBuffer(secret)||secret.length<32)
  throw new PaymentError('M8_WEBHOOK_SECRET_INVALID');
 if(!Buffer.isBuffer(raw)||raw.length===0||raw.length>8192)
  throw new PaymentError('M8_WEBHOOK_INVALID');
 if(!/^\d{10}$/.test(timestamp)||!Number.isSafeInteger(now)||
   Math.abs(Math.floor(now/1000)-Number(timestamp))>300)
  throw new PaymentError('M8_WEBHOOK_TIMESTAMP_INVALID');
 if(!/^v1=[a-f0-9]{64}$/.test(header))
  throw new PaymentError('M8_WEBHOOK_SIGNATURE_INVALID');
 const expected=createHmac('sha256',secret).update(timestamp).update('.')
  .update(raw).digest();
 const given=Buffer.from(header.slice(3),'hex');
 if(given.length!==expected.length||!timingSafeEqual(given,expected))
  throw new PaymentError('M8_WEBHOOK_SIGNATURE_INVALID');
}
export async function ingestLabWebhook(pool:Pool,secret:Buffer,raw:Buffer,
 timestamp:string,signature:string){
 verifyLabSignature(secret,raw,timestamp,signature);
 const event=validateEvent(raw);
 const fingerprint=digest(event);
 return tx(pool,async c=>{
  // Lock payment before checking duplicate event; serializes all effects
  // including refund requests and replays for the same payment.
  const p=await c.query<{state:string,amount_cents:string,currency:string,provider:string}>(
   'SELECT state,amount_cents,currency,provider FROM tala_payments_v2.payments '+
   'WHERE id=$1::uuid FOR UPDATE',[event.paymentId]);
  if(!p.rows[0])throw new PaymentError('M8_PAYMENT_NOT_FOUND');
  if(p.rows[0].provider!=='simulated_lab')
   throw new PaymentError('M8_PAYMENT_PROVIDER_CONFLICT');
  const old=await c.query<{fingerprint:string,payment_id:string}>(
   'SELECT fingerprint,payment_id FROM tala_payments_v2.provider_events '+
   'WHERE event_id=$1::uuid',[event.eventId]);
  if(old.rows[0]){
   if(old.rows[0].fingerprint!==fingerprint||
      old.rows[0].payment_id!==event.paymentId)
    throw new PaymentError('M8_WEBHOOK_REPLAY_CONFLICT');
   return Object.freeze({eventId:event.eventId,replayed:true,applied:false});
  }
  if(p.rows[0].currency!==event.currency)
   throw new PaymentError('M8_WEBHOOK_AMOUNT_MISMATCH');
  if(event.kind.startsWith('payment.')){
   if(p.rows[0].state!=='pending')
    throw new PaymentError('M8_EVENT_STATE_CONFLICT');
   if(Number(p.rows[0].amount_cents)!==event.amountCents)
    throw new PaymentError('M8_WEBHOOK_AMOUNT_MISMATCH');
   const state=event.kind==='payment.succeeded'?'succeeded':
    event.kind==='payment.failed'?'failed':'canceled';
   try{
    await c.query('UPDATE tala_payments_v2.payments SET '+
     'state=$2,provider_ref=$3,version=version+1,'+
     'updated_at=clock_timestamp() WHERE id=$1::uuid',
     [event.paymentId,state,event.providerRef??null]);
   }catch(e){
    if((e as {code?:string}).code==='23505')
     throw new PaymentError('M8_PROVIDER_REFERENCE_CONFLICT');
    throw e;
   }
  }else{
   if(p.rows[0].state!=='succeeded')
    throw new PaymentError('M8_EVENT_STATE_CONFLICT');
   const refundId=event.refundId!;
   const r=await c.query<{payment_id:string,state:string,amount_cents:string}>(
    'SELECT payment_id,state,amount_cents FROM tala_payments_v2.refunds '+
    'WHERE id=$1::uuid FOR UPDATE',[refundId]);
   if(!r.rows[0]||r.rows[0].payment_id!==event.paymentId)
    throw new PaymentError('M8_REFUND_NOT_FOUND');
   if(r.rows[0].state!=='requested')
    throw new PaymentError('M8_EVENT_STATE_CONFLICT');
   if(Number(r.rows[0].amount_cents)!==event.amountCents)
    throw new PaymentError('M8_WEBHOOK_AMOUNT_MISMATCH');
   const state=event.kind==='refund.succeeded'?'succeeded':'failed';
   try{
    await c.query('UPDATE tala_payments_v2.refunds SET '+
     'state=$2,provider_ref=$3,version=version+1,'+
     'updated_at=clock_timestamp() WHERE id=$1::uuid',
     [refundId,state,event.providerRef??null]);
   }catch(e){
    if((e as {code?:string}).code==='23505')
     throw new PaymentError('M8_PROVIDER_REFERENCE_CONFLICT');
    throw e;
   }
  }
  try{
   await c.query('INSERT INTO tala_payments_v2.provider_events '+
    '(event_id,event_kind,payment_id,refund_id,fingerprint,outcome) '+
    "VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5,'applied')",
    [event.eventId,event.kind,event.paymentId,event.refundId??null,fingerprint]);
  }catch(e){
   if((e as {code?:string}).code==='23505')
    throw new PaymentError('M8_WEBHOOK_REPLAY_CONFLICT');
   throw e;
  }
  if(event.kind==='payment.succeeded'||event.kind==='refund.succeeded'){
   await c.query('INSERT INTO tala_payments_v2.verified_facts '+
    '(event_id,payment_id,refund_id,fact_type,amount_cents) '+
    'VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5)',[
      event.eventId,event.paymentId,event.refundId??null,
      event.kind==='payment.succeeded'?
       'FundsConfirmed.v1':'ProviderRefundConfirmed.v1',
      event.amountCents
    ]);
  }
  return Object.freeze({eventId:event.eventId,replayed:false,applied:true});
 });
}
