/** Official Stripe-Signature shape for Stripe TEST events only.
 * Authenticate raw bytes before JSON parsing; never accept livemode events.
 * This adapter records TEST events/facts inside M8, never posts to M3.
 */
import {createHmac,timingSafeEqual,createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {PaymentError,uuid} from './domain.js';
import {tx} from './db.js';

const STRIPE_TYPES=['payment_intent.succeeded','payment_intent.canceled',
 'payment_intent.payment_failed','refund.created','refund.updated',
 'refund.failed'] as const;
type EventType=typeof STRIPE_TYPES[number];
const PI=/^pi_[A-Za-z0-9]{4,128}$/;
const RE=/^re_[A-Za-z0-9]{4,128}$/;
const EVT=/^evt_[A-Za-z0-9]{4,128}$/;
const safe=(value:unknown):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value))
  throw new PaymentError('M8_STRIPE_WEBHOOK_INVALID');
 return value as Record<string,unknown>;
};
export function verifyStripeTestSignature(secret:string,raw:Buffer,
 header:string,now=Date.now()){
 if(typeof secret!=='string'||!/^whsec_[A-Za-z0-9_]{12,}$/.test(secret))
  throw new PaymentError('M8_STRIPE_WEBHOOK_SECRET_INVALID');
 if(!Buffer.isBuffer(raw)||raw.length<2||raw.length>65536)
  throw new PaymentError('M8_STRIPE_WEBHOOK_INVALID');
 if(typeof header!=='string'||header.length>2048)
  throw new PaymentError('M8_STRIPE_SIGNATURE_INVALID');
 const pieces=header.split(',').map(x=>x.trim().split('='));
 const t=pieces.filter(x=>x[0]==='t'&&x.length===2);
 const signatures=pieces.filter(x=>x[0]==='v1'&&x.length===2&&
   /^[a-f0-9]{64}$/i.test(x[1]??''));
 if(t.length!==1||signatures.length===0||!/^\d{10}$/.test(t[0]![1]??'')||
    !Number.isSafeInteger(now)||Math.abs(Math.floor(now/1000)-Number(t[0]![1]))>300)
  throw new PaymentError('M8_STRIPE_SIGNATURE_INVALID');
 const timestamp=t[0]![1]!;
 const expected=createHmac('sha256',secret).update(timestamp).update('.')
  .update(raw).digest();
 if(!signatures.some(x=>{
  const b=Buffer.from(x[1]!, 'hex');
  return b.length===expected.length&&timingSafeEqual(b,expected);
 }))throw new PaymentError('M8_STRIPE_SIGNATURE_INVALID');
}
type VerifiedEvent={id:string,type:EventType,object:Record<string,unknown>,
  fingerprint:string,rawObjectId:string};
function parseEvent(raw:Buffer):VerifiedEvent|null{
 let o:Record<string,unknown>;
 try{o=safe(JSON.parse(raw.toString('utf8')))}catch{
  throw new PaymentError('M8_STRIPE_WEBHOOK_INVALID');
 }
 if(o.livemode!==false)throw new PaymentError('M8_STRIPE_LIVEMODE_FORBIDDEN');
 if(typeof o.id!=='string'||!EVT.test(o.id)||typeof o.type!=='string')
  throw new PaymentError('M8_STRIPE_WEBHOOK_INVALID');
 if(!STRIPE_TYPES.includes(o.type as EventType))return null;
 const data=safe(o.data),object=safe(data.object);
 if((o.type.startsWith('refund.')?
   object.livemode===true||(object.livemode!==undefined&&object.livemode!==false):
   object.livemode!==false)||typeof object.id!=='string')
  throw new PaymentError('M8_STRIPE_LIVEMODE_FORBIDDEN');
 const refund=o.type.startsWith('refund.');
 if((refund&&!RE.test(object.id))||(!refund&&!PI.test(object.id))||
    object.currency!=='mxn'||typeof object.amount!=='number'||
    !Number.isSafeInteger(object.amount)||object.amount<1)
  throw new PaymentError('M8_STRIPE_WEBHOOK_INVALID');
 return {id:o.id,type:o.type as EventType,object,
  fingerprint:createHash('sha256').update(raw).digest('hex'),
  rawObjectId:object.id};
}

export async function ingestStripeTestWebhook(pool:Pool,secret:string,
 raw:Buffer,signature:string){
 verifyStripeTestSignature(secret,raw,signature);
 const event=parseEvent(raw);
 if(!event)return Object.freeze({ignored:true as const,applied:false});
 return tx(pool,async c=>{
  const refund=event.type.startsWith('refund.');
  let paymentId:string,refundId:string|null=null,
   currentState:string,expectedCents:number;
  if(!refund){
   const metadata=safe(event.object.metadata);
   const suppliedId=uuid(metadata.m8_payment_id);
   const r=await c.query<{id:string,state:string,amount_cents:string,
    provider:string}>(
    'SELECT p.id,p.state,p.amount_cents::text,p.provider '+
    'FROM tala_payments_v2.stripe_test_intents i '+
    'JOIN tala_payments_v2.payments p ON p.id=i.payment_id '+
    'WHERE i.stripe_intent_id=$1 FOR UPDATE OF p',[event.rawObjectId]);
   if(!r.rows[0]||r.rows[0].provider!=='stripe_test'||
     r.rows[0].id!==suppliedId)
    throw new PaymentError('M8_STRIPE_UNBOUND_EVENT');
   paymentId=r.rows[0].id;currentState=r.rows[0].state;
   expectedCents=Number(r.rows[0].amount_cents);
  }else{
   const metadata=safe(event.object.metadata);
   const suppliedId=uuid(metadata.m8_refund_id);
   const r=await c.query<{id:string,payment_id:string,amount_cents:string,
    state:string,provider:string,stripe_intent_id:string}>(
    'SELECT r.id,r.payment_id,r.amount_cents::text,r.state,'+
    'p.provider,i.stripe_intent_id FROM tala_payments_v2.stripe_test_refunds sr '+
    'JOIN tala_payments_v2.refunds r ON r.id=sr.refund_id '+
    'JOIN tala_payments_v2.payments p ON p.id=r.payment_id '+
    'JOIN tala_payments_v2.stripe_test_intents i ON i.payment_id=p.id '+
    'WHERE sr.stripe_refund_id=$1 FOR UPDATE OF p,r',
    [event.rawObjectId]);
   if(!r.rows[0]||r.rows[0].provider!=='stripe_test'||
     r.rows[0].id!==suppliedId||
     event.object.payment_intent!==r.rows[0].stripe_intent_id)
    throw new PaymentError('M8_STRIPE_UNBOUND_EVENT');
   paymentId=r.rows[0].payment_id;refundId=r.rows[0].id;
   currentState=r.rows[0].state;expectedCents=Number(r.rows[0].amount_cents);
  }
  if(event.object.amount!==expectedCents)
   throw new PaymentError('M8_STRIPE_AMOUNT_MISMATCH');
  const existing=await c.query<{fingerprint:string,payment_id:string,
    refund_id:string|null}>(
   'SELECT fingerprint,payment_id,refund_id '+
   'FROM tala_payments_v2.stripe_test_events WHERE stripe_event_id=$1',
   [event.id]);
  if(existing.rows[0]){
   if(existing.rows[0].fingerprint!==event.fingerprint||
     existing.rows[0].payment_id!==paymentId||
     existing.rows[0].refund_id!==refundId)
    throw new PaymentError('M8_STRIPE_EVENT_REPLAY_CONFLICT');
   return Object.freeze({eventId:event.id,replayed:true,applied:false});
  }
  let applied=false,factType:string|null=null;
  if(!refund){
   const status=event.object.status;
   if(event.type==='payment_intent.succeeded'){
    if(status!=='succeeded'||event.object.amount_received!==expectedCents)
     throw new PaymentError('M8_STRIPE_WEBHOOK_INVALID');
    if(currentState==='pending'){
     await c.query('UPDATE tala_payments_v2.payments SET state=$2,'+
      'version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid',
      [paymentId,'succeeded']);
     applied=true;factType='FundsConfirmed.v1';
    }else if(currentState!=='succeeded')
     throw new PaymentError('M8_EVENT_STATE_CONFLICT');
   }else if(event.type==='payment_intent.canceled'){
    if(status!=='canceled')throw new PaymentError('M8_STRIPE_WEBHOOK_INVALID');
    if(currentState==='pending'){
     await c.query('UPDATE tala_payments_v2.payments SET state=$2,'+
      'version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid',
      [paymentId,'canceled']);
     applied=true;
    }else if(currentState!=='canceled')
     throw new PaymentError('M8_EVENT_STATE_CONFLICT');
   }else if(event.type==='payment_intent.payment_failed'){
    // A failed attempt is not necessarily a terminal PaymentIntent.
    // But its signed payload must not claim the charge succeeded.
    if(status!=='requires_payment_method'&&status!=='requires_confirmation')
     throw new PaymentError('M8_STRIPE_WEBHOOK_INVALID');
   }
  }else{
   const status=event.object.status;
   if(event.type==='refund.failed'&&status!=='failed')
    throw new PaymentError('M8_STRIPE_WEBHOOK_INVALID');
   if(status==='succeeded'&&currentState==='requested'){
    await c.query('UPDATE tala_payments_v2.refunds SET state=$2,'+
     'version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid',
     [refundId,'succeeded']);
    applied=true;factType='ProviderRefundConfirmed.v1';
   }else if(status==='failed'&&currentState==='requested'){
    await c.query('UPDATE tala_payments_v2.refunds SET state=$2,'+
     'version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid',
     [refundId,'failed']);
    applied=true;
   }else if(status!=='pending'&&status!=='requires_action'&&
      status!=='succeeded'&&status!=='failed'){
    throw new PaymentError('M8_STRIPE_WEBHOOK_INVALID');
   }else if(currentState==='failed'&&status==='succeeded'||
      currentState==='succeeded'&&status==='failed')
    throw new PaymentError('M8_EVENT_STATE_CONFLICT');
  }
  await c.query('INSERT INTO tala_payments_v2.stripe_test_events '+
   '(stripe_event_id,kind,payment_id,refund_id,fingerprint,outcome) '+
   'VALUES($1,$2,$3::uuid,$4::uuid,$5,$6)',
   [event.id,event.type,paymentId,refundId,event.fingerprint,
    applied?'applied':'noop']);
  if(factType){
   await c.query('INSERT INTO tala_payments_v2.stripe_test_facts '+
    '(stripe_event_id,payment_id,refund_id,fact_type,amount_cents) '+
    'VALUES($1,$2::uuid,$3::uuid,$4,$5)',
    [event.id,paymentId,refundId,factType,expectedCents]);
  }
  return Object.freeze({eventId:event.id,replayed:false,applied,
   testOnly:true as const});
 });
}
