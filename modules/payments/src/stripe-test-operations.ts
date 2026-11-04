/** M8 Stripe TEST operation coordination. Remote requests happen OUTSIDE
 * database transactions, after durable idempotency and a short lease.
 * This avoids accidental duplicate remote writes when a worker crashes.
 */
import type {Pool} from 'pg';
import {PaymentError,requireActor,uuid,type Actor} from './domain.js';
import {tx} from './db.js';
import {StripeTestClient} from './stripe-test-client.js';

const LEASE="interval '45 seconds'";
const RETRY_HOURS="interval '20 hours'";
type IntentRow={payment_id:string,idempotency_key:string,
 stripe_intent_id:string|null,amount_cents:string,state:string,lease_available:boolean,
 retry_allowed:boolean};
type RefundRow={refund_id:string,payment_id:string,idempotency_key:string,
 stripe_refund_id:string|null,stripe_intent_id:string,amount_cents:string,
 state:string,lease_available:boolean,retry_allowed:boolean};

async function reserveIntent(pool:Pool,paymentId:string){
 return tx(pool,async c=>{
  const p=await c.query<{state:string,provider:string,amount_cents:string,
    provider_ref:string|null}>(
   'SELECT state,provider,amount_cents,provider_ref FROM tala_payments_v2.payments '+
   'WHERE id=$1::uuid FOR UPDATE',[paymentId]);
  const payment=p.rows[0];
  if(!payment)throw new PaymentError('M8_PAYMENT_NOT_FOUND');
  if(payment.provider!=='simulated_lab'&&payment.provider!=='stripe_test')
   throw new PaymentError('M8_PAYMENT_PROVIDER_CONFLICT');
  if(payment.state!=='pending'&&!(payment.provider==='stripe_test'&&
    payment.state==='succeeded'))
   throw new PaymentError('M8_EVENT_STATE_CONFLICT');
  let r=await c.query<IntentRow>(
   'SELECT i.payment_id,i.idempotency_key,i.stripe_intent_id,'+
   'p.amount_cents::text,p.state,'+
   '(i.lease_until IS NULL OR i.lease_until<=clock_timestamp()) AS lease_available,'+
   "(i.operation_started_at>clock_timestamp()-"+RETRY_HOURS+") AS retry_allowed "+
   'FROM tala_payments_v2.stripe_test_intents i '+
   'JOIN tala_payments_v2.payments p ON p.id=i.payment_id '+
   'WHERE i.payment_id=$1::uuid FOR UPDATE',[paymentId]);
  if(!r.rows[0]){
   if(payment.provider!=='simulated_lab'||payment.provider_ref!==null)
    throw new PaymentError('M8_PAYMENT_PROVIDER_CONFLICT');
   await c.query('UPDATE tala_payments_v2.payments SET provider=$2,'+
    'version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid',
    [paymentId,'stripe_test']);
   await c.query('INSERT INTO tala_payments_v2.stripe_test_intents '+
    '(payment_id,idempotency_key) VALUES($1::uuid,$2)',
    [paymentId,'m8-pi-'+paymentId]);
   r=await c.query<IntentRow>(
    'SELECT i.payment_id,i.idempotency_key,i.stripe_intent_id,'+
    'p.amount_cents::text,p.state,true AS lease_available,'+
    'true AS retry_allowed FROM tala_payments_v2.stripe_test_intents i '+
    'JOIN tala_payments_v2.payments p ON p.id=i.payment_id '+
    'WHERE i.payment_id=$1::uuid',[paymentId]);
  }
  const state=r.rows[0]!;
  if(payment.provider!=='stripe_test'&&payment.provider_ref!==null)
   throw new PaymentError('M8_PAYMENT_PROVIDER_CONFLICT');
  if(state.stripe_intent_id)return Object.freeze({
   attached:true as const, intentId:state.stripe_intent_id,
   paymentId,amountCents:Number(state.amount_cents),state:state.state});
  if(!state.retry_allowed)
   throw new PaymentError('M8_STRIPE_RECONCILIATION_REQUIRED');
  if(!state.lease_available)
   throw new PaymentError('M8_STRIPE_OPERATION_IN_PROGRESS');
  await c.query('UPDATE tala_payments_v2.stripe_test_intents SET '+
   'lease_until=clock_timestamp()+'+LEASE+' WHERE payment_id=$1::uuid',
   [paymentId]);
  return Object.freeze({attached:false as const,paymentId,
   amountCents:Number(state.amount_cents),idempotencyKey:state.idempotency_key,
   state:state.state});
 });
}
export async function createStripeTestIntent(pool:Pool,client:StripeTestClient,
 actor:Actor,paymentId:string){
 requireActor(actor,'canCreatePayments');
 const id=uuid(paymentId),reserved=await reserveIntent(pool,id);
 const intent=reserved.attached?
  await client.retrieveIntent({intentId:reserved.intentId,
   paymentId:id,amountCents:reserved.amountCents}):
  await client.createIntent({paymentId:id,amountCents:reserved.amountCents,
   idempotencyKey:reserved.idempotencyKey});
 if(!reserved.attached){
  await tx(pool,async c=>{
   const p=await c.query<{state:string,provider:string}>(
    'SELECT state,provider FROM tala_payments_v2.payments '+
    'WHERE id=$1::uuid FOR UPDATE',[id]);
   if(p.rows[0]?.provider!=='stripe_test')
    throw new PaymentError('M8_PAYMENT_PROVIDER_CONFLICT');
   const r=await c.query<{stripe_intent_id:string|null}>(
    'SELECT stripe_intent_id FROM tala_payments_v2.stripe_test_intents '+
    'WHERE payment_id=$1::uuid FOR UPDATE',[id]);
   if(!r.rows[0])throw new PaymentError('M8_STRIPE_RECONCILIATION_REQUIRED');
   if(r.rows[0].stripe_intent_id!==null&&
      r.rows[0].stripe_intent_id!==intent.id)
    throw new PaymentError('M8_STRIPE_RECONCILIATION_REQUIRED');
   if(r.rows[0].stripe_intent_id===null){
    await c.query('UPDATE tala_payments_v2.stripe_test_intents SET '+
     'stripe_intent_id=$2,attached_at=clock_timestamp(),lease_until=NULL '+
     'WHERE payment_id=$1::uuid',[id,intent.id]);
    await c.query('UPDATE tala_payments_v2.payments SET provider_ref=$2,'+
     'version=version+1,updated_at=clock_timestamp() '+
     'WHERE id=$1::uuid AND provider=$3',
     [id,intent.id,'stripe_test']);
   }
  });
 }
 // Client secret only to authenticated host for a pending payment.
 return Object.freeze({paymentId:id,intentId:intent.id,
  clientSecret:reserved.state==='succeeded'?null:intent.client_secret,
  status:intent.status,livemode:false as const,provider:'stripe_test' as const});
}

async function reserveRefund(pool:Pool,refundId:string){
 return tx(pool,async c=>{
  const owner=await c.query<{payment_id:string}>(
   'SELECT payment_id FROM tala_payments_v2.refunds WHERE id=$1::uuid',
   [refundId]);
  if(!owner.rows[0])throw new PaymentError('M8_REFUND_NOT_FOUND');
  const paymentId=owner.rows[0].payment_id;
  const p=await c.query<{provider:string,state:string}>(
   'SELECT provider,state FROM tala_payments_v2.payments '+
   'WHERE id=$1::uuid FOR UPDATE',[paymentId]);
  if(p.rows[0]?.provider!=='stripe_test'||p.rows[0].state!=='succeeded')
   throw new PaymentError('M8_PAYMENT_NOT_SETTLED');
  const r=await c.query<RefundRow>(
   'SELECT r.id AS refund_id,r.payment_id,r.amount_cents::text,r.state,'+
   'i.stripe_intent_id, s.idempotency_key,s.stripe_refund_id,'+
   '(s.lease_until IS NULL OR s.lease_until<=clock_timestamp()) AS lease_available,'+
   "(s.operation_started_at>clock_timestamp()-"+RETRY_HOURS+") AS retry_allowed "+
   'FROM tala_payments_v2.refunds r '+
   'JOIN tala_payments_v2.stripe_test_intents i ON i.payment_id=r.payment_id '+
   'LEFT JOIN tala_payments_v2.stripe_test_refunds s ON s.refund_id=r.id '+
   'WHERE r.id=$1::uuid FOR UPDATE OF r',[refundId]);
  if(!r.rows[0]||!r.rows[0].stripe_intent_id)
   throw new PaymentError('M8_STRIPE_RECONCILIATION_REQUIRED');
  if(r.rows[0].state!=='requested'){
   if(r.rows[0].stripe_refund_id)return Object.freeze({
    attached:true as const,refundId,paymentId,
    stripeRefundId:r.rows[0].stripe_refund_id,state:r.rows[0].state});
   throw new PaymentError('M8_EVENT_STATE_CONFLICT');
  }
  if(r.rows[0].stripe_refund_id)return Object.freeze({
   attached:true as const,refundId,paymentId,
   stripeRefundId:r.rows[0].stripe_refund_id,state:r.rows[0].state});
  if(!r.rows[0].idempotency_key){
   await c.query('INSERT INTO tala_payments_v2.stripe_test_refunds '+
    '(refund_id,idempotency_key) VALUES($1::uuid,$2)',
    [refundId,'m8-re-'+refundId]);
  }else if(!r.rows[0].retry_allowed){
   throw new PaymentError('M8_STRIPE_RECONCILIATION_REQUIRED');
  }else if(!r.rows[0].lease_available){
   throw new PaymentError('M8_STRIPE_OPERATION_IN_PROGRESS');
  }
  await c.query('UPDATE tala_payments_v2.stripe_test_refunds SET '+
   'lease_until=clock_timestamp()+'+LEASE+' WHERE refund_id=$1::uuid',
   [refundId]);
  return Object.freeze({attached:false as const,refundId,paymentId,
   intentId:r.rows[0].stripe_intent_id,amountCents:Number(r.rows[0].amount_cents),
   idempotencyKey:'m8-re-'+refundId});
 });
}
export async function sendStripeTestRefund(pool:Pool,client:StripeTestClient,
 actor:Actor,refundId:string){
 requireActor(actor,'canRefundPayments');
 const id=uuid(refundId),op=await reserveRefund(pool,id);
 if(op.attached)return Object.freeze({refundId:id,
  stripeRefundId:op.stripeRefundId,status:op.state,
  livemode:false as const,provider:'stripe_test' as const});
 const result=await client.createRefund({refundId:id,intentId:op.intentId,
  amountCents:op.amountCents,idempotencyKey:op.idempotencyKey});
 await tx(pool,async c=>{
  const p=await c.query<{provider:string}>(
   'SELECT p.provider FROM tala_payments_v2.payments p '+
   'JOIN tala_payments_v2.refunds r ON r.payment_id=p.id '+
   'WHERE r.id=$1::uuid FOR UPDATE OF p',[id]);
  if(p.rows[0]?.provider!=='stripe_test')
   throw new PaymentError('M8_PAYMENT_PROVIDER_CONFLICT');
  const row=await c.query<{stripe_refund_id:string|null}>(
   'SELECT stripe_refund_id FROM tala_payments_v2.stripe_test_refunds '+
   'WHERE refund_id=$1::uuid FOR UPDATE',[id]);
  if(!row.rows[0]||(row.rows[0].stripe_refund_id!==null&&
     row.rows[0].stripe_refund_id!==result.id))
   throw new PaymentError('M8_STRIPE_RECONCILIATION_REQUIRED');
  if(row.rows[0].stripe_refund_id===null){
   await c.query('UPDATE tala_payments_v2.stripe_test_refunds '+
    'SET stripe_refund_id=$2,attached_at=clock_timestamp(),lease_until=NULL '+
    'WHERE refund_id=$1::uuid',[id,result.id]);
   await c.query('UPDATE tala_payments_v2.refunds SET provider_ref=$2,'+
    'version=version+1,updated_at=clock_timestamp() WHERE id=$1::uuid',
    [id,result.id]);
  }
 });
 return Object.freeze({refundId:id,stripeRefundId:result.id,
  status:result.status,livemode:false as const,provider:'stripe_test' as const});
}
