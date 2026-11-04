import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {PaymentError} from '../src/domain.js';
import {createPayment,requestRefund,readPayment} from '../src/payments.js';
import {StripeTestClient} from '../src/stripe-test-client.js';
import {createStripeTestIntent,sendStripeTestRefund} from '../src/stripe-test-operations.js';
import {ingestStripeTestWebhook} from '../src/stripe-test-webhook.js';
import {ingestLabWebhook} from '../src/webhook.js';

const url=process.env.PAYMENTS_CI_URL??'';
const enabled=url.includes('/tala_payments_v2_test');
const uuid=()=>randomUUID();
const testKey='sk_test_M8_OFFLINE_FIXTURE_NO_EXTERNAL_REQUESTS';
const webhookSecret='whsec_M8_OFFLINE_FIXTURE_SECRET_123456789';
const freshPi=()=> 'pi_'+randomBytes(16).toString('hex');
const freshRefund=()=> 're_'+randomBytes(16).toString('hex');
const operator={actorId:uuid(),canCreatePayments:true,
 canRefundPayments:true,canReadPayments:true};
const fail=(call:()=>Promise<unknown>,code:string)=>assert.rejects(call,
 (e:unknown)=>e instanceof PaymentError&&e.code===code);

function mockStripe(){
 const calls:Array<{url:string,key:string,method:string,fields:URLSearchParams}>=[];
 let intentId=freshPi(),refundId=freshRefund();
 const client=new StripeTestClient({apiKey:testKey,transport:async(url,init)=>{
  const headers=new Headers(init?.headers),
   params=new URLSearchParams(String(init?.body??''));
  const path=String(url);
  calls.push({url:path,method:String(init?.method),
   key:String(headers.get('idempotency-key')),fields:params});
  if(path.endsWith('/v1/payment_intents')&&init?.method==='POST'){
   return new Response(JSON.stringify({
    id:intentId,object:'payment_intent',livemode:false,
    amount:Number(params.get('amount')),currency:'mxn',
    status:'requires_payment_method',client_secret:intentId+'_secret_test',
    metadata:{m8_payment_id:params.get('metadata[m8_payment_id]')}
   }),{status:200});
  }
  if(path.endsWith('/v1/refunds')&&init?.method==='POST'){
   return new Response(JSON.stringify({
    id:refundId,object:'refund',livemode:false,
    amount:Number(params.get('amount')),currency:'mxn',
    status:'pending',payment_intent:params.get('payment_intent'),
    metadata:{m8_refund_id:params.get('metadata[m8_refund_id]')}
   }),{status:200});
  }
  if(path.includes('/v1/payment_intents/')&&init?.method==='GET'){
   const paymentId=intentOwner;
   return new Response(JSON.stringify({
    id:intentId,object:'payment_intent',livemode:false,
    amount:intentAmount,currency:'mxn',
    status:'requires_payment_method',client_secret:intentId+'_secret_test',
    metadata:{m8_payment_id:paymentId}
   }),{status:200});
  }
  return new Response('{}',{status:404});
 }});
 let intentOwner='',intentAmount=0;
 return {client,calls,setIntentOwner:(id:string,amount:number)=>{
  intentOwner=id;intentAmount=amount;
 },setRefundId:(id:string)=>{refundId=id;},
 setIntentId:(id:string)=>{intentId=id;},
  getIntentId:()=>intentId,getRefundId:()=>refundId};
}
function stripeEvent(type:string,obj:Record<string,unknown>){
 return {id:'evt_'+randomBytes(12).toString('hex'),type,livemode:false,
  data:{object:obj}};
}
function signed(input:unknown){
 const raw=Buffer.from(JSON.stringify(input));
 const ts=String(Math.floor(Date.now()/1000));
 const signature='t='+ts+',v1='+createHmac('sha256',webhookSecret)
  .update(ts).update('.').update(raw).digest('hex');
 return {raw,signature};
}
function intentObject(paymentId:string,amount:number,status:string,
 intentId:string,extra:Record<string,unknown>={}){
 return {id:intentId,object:'payment_intent',livemode:false,
  amount,amount_received:amount,currency:'mxn',status,
  metadata:{m8_payment_id:paymentId},...extra};
}
function refundObject(refundId:string,amount:number,status:string,
 stripeRefundId:string,stripeIntentId:string){
 return {id:stripeRefundId,object:'refund',livemode:false,amount,
  currency:'mxn',status,payment_intent:stripeIntentId,
  metadata:{m8_refund_id:refundId}};
}

test('M8 LAB2 Stripe TEST PI setup is durable, test-only and rejects mock provider takeover',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 const provider=mockStripe();
 try{
  const pay=await createPayment(pool,operator,{
   operationId:uuid(),orderRef:uuid(),customerRef:uuid(),
   amountCents:49900,currency:'MXN'});
  provider.setIntentOwner(pay.id,49900);
  const setup=await createStripeTestIntent(pool,provider.client,operator,pay.id);
  assert.equal(setup.intentId,provider.getIntentId());
  assert.equal(setup.provider,'stripe_test');
  assert.equal(setup.livemode,false);
  assert.equal(provider.calls.length,1);
  assert.equal(provider.calls[0]!.key,'m8-pi-'+pay.id);
  const repeat=await createStripeTestIntent(pool,provider.client,operator,pay.id);
  assert.equal(repeat.intentId,provider.getIntentId());
  assert.equal(provider.calls.length,2);
  assert.equal(provider.calls[1]!.method,'GET');
  const record=await pool.query<{provider:string,provider_ref:string}>(
   'SELECT provider,provider_ref FROM tala_payments_v2.payments WHERE id=$1::uuid',
   [pay.id]);
  assert.equal(record.rows[0]!.provider,'stripe_test');
  assert.equal(record.rows[0]!.provider_ref,provider.getIntentId());
  const raw=Buffer.from(JSON.stringify({
   eventId:uuid(),kind:'payment.succeeded',paymentId:pay.id,
   amountCents:49900,currency:'MXN',providerRef:'lab_fake_12345'}));
  const ts=String(Math.floor(Date.now()/1000));
  const signature='v1='+createHmac('sha256',Buffer.alloc(32,1))
   .update(ts).update('.').update(raw).digest('hex');
  await fail(()=>ingestLabWebhook(pool,Buffer.alloc(32,1),raw,ts,signature),
   'M8_PAYMENT_PROVIDER_CONFLICT');
  assert.equal((await readPayment(pool,operator,pay.id)).state,'pending');
  const webhook=signed(stripeEvent('payment_intent.succeeded',
   intentObject(pay.id,49900,'succeeded',provider.getIntentId())));
  const applied=await ingestStripeTestWebhook(pool,webhookSecret,
   webhook.raw,webhook.signature);
  assert.equal(applied.applied,true);
  const duplicatePayment=await ingestStripeTestWebhook(pool,webhookSecret,
   webhook.raw,webhook.signature);
  assert.equal('replayed' in duplicatePayment&&duplicatePayment.replayed,true);
  assert.equal((await readPayment(pool,operator,pay.id)).state,'succeeded');
  const stripeFacts=await pool.query<{source:string,amount_cents:string}>(
   'SELECT source,amount_cents::text FROM tala_payments_v2.stripe_test_facts '+
   'WHERE payment_id=$1::uuid',[pay.id]);
  assert.deepEqual(stripeFacts.rows,[{source:'stripe_test',amount_cents:'49900'}]);
  assert.equal((await readPayment(pool,operator,pay.id)).facts.length,0,
   'Stripe TEST facts must never masquerade as synthetic or finance LIVE facts');
  const rerun=await createStripeTestIntent(pool,provider.client,operator,pay.id);
  assert.equal(rerun.clientSecret,null);
  await assert.rejects(pool.query('DELETE FROM tala_payments_v2.stripe_test_facts '+
   'WHERE payment_id=$1::uuid',[pay.id]),/IMMUTABLE/);
 }finally{await pool.end();}
});

test('M8 LAB2 refund provider results are not settlement until signed webhook',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 const provider=mockStripe();
 try{
  const p=await createPayment(pool,operator,{operationId:uuid(),
   orderRef:uuid(),customerRef:uuid(),amountCents:10000,currency:'MXN'});
  provider.setIntentOwner(p.id,10000);
  await createStripeTestIntent(pool,provider.client,operator,p.id);
  const paid=signed(stripeEvent('payment_intent.succeeded',
   intentObject(p.id,10000,'succeeded',provider.getIntentId())));
  await ingestStripeTestWebhook(pool,webhookSecret,paid.raw,paid.signature);
  const requested=await requestRefund(pool,operator,{
   operationId:uuid(),paymentId:p.id,amountCents:7000});
  const sent=await sendStripeTestRefund(pool,provider.client,operator,requested.id);
  assert.equal(sent.stripeRefundId,provider.getRefundId());
  assert.equal(sent.status,'pending');
  assert.equal((await readPayment(pool,operator,p.id)).refunds[0]!.state,
   'requested');
  const resend=await sendStripeTestRefund(pool,provider.client,operator,requested.id);
  assert.equal(resend.stripeRefundId,provider.getRefundId());
  assert.equal(provider.calls.filter(x=>x.url.endsWith('/v1/refunds')).length,1);
  const bad=signed(stripeEvent('refund.updated',
   refundObject(requested.id,7001,'succeeded',provider.getRefundId(),provider.getIntentId())));
  await fail(()=>ingestStripeTestWebhook(pool,webhookSecret,bad.raw,
   bad.signature),'M8_STRIPE_AMOUNT_MISMATCH');
  const completed=signed(stripeEvent('refund.updated',
   refundObject(requested.id,7000,'succeeded',provider.getRefundId(),provider.getIntentId())));
  const first=await ingestStripeTestWebhook(pool,webhookSecret,
   completed.raw,completed.signature);
  assert.equal(first.applied,true);
  const repeated=await ingestStripeTestWebhook(pool,webhookSecret,
   completed.raw,completed.signature);
  assert.equal('replayed' in repeated&&repeated.replayed,true);
  assert.equal((await readPayment(pool,operator,p.id)).refunds[0]!.state,
   'succeeded');
  const rest=await requestRefund(pool,operator,{
   operationId:uuid(),paymentId:p.id,amountCents:3000});
  provider.setRefundId('re_M8TestRefund222222222');
  await sendStripeTestRefund(pool,provider.client,operator,rest.id);
  await fail(()=>requestRefund(pool,operator,{operationId:uuid(),
   paymentId:p.id,amountCents:1}),'M8_REFUND_EXCEEDS_PAYMENT');
  const pending=await pool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_payments_v2.stripe_test_facts '+
   'WHERE payment_id=$1::uuid',[p.id]);
  assert.equal(pending.rows[0]!.n,2); // payment + first refund only
 }finally{await pool.end();}
});

test('M8 LAB2 uncertain gateway result blocks immediate duplicates and aged retries',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 const failing=new StripeTestClient({apiKey:testKey,transport:async()=>{
  throw new Error('network failure, provider result unknown');
 }});
 const recovered=mockStripe();
 try{
  const p=await createPayment(pool,operator,{operationId:uuid(),
   orderRef:uuid(),customerRef:uuid(),amountCents:2500,currency:'MXN'});
  await fail(()=>createStripeTestIntent(pool,failing,operator,p.id),
   'M8_STRIPE_NETWORK_UNCERTAIN');
  await fail(()=>createStripeTestIntent(pool,recovered.client,operator,p.id),
   'M8_STRIPE_OPERATION_IN_PROGRESS');
  await pool.query('UPDATE tala_payments_v2.stripe_test_intents SET '+
   "lease_until=clock_timestamp()-interval '10 seconds' "+
   'WHERE payment_id=$1::uuid',[p.id]);
  recovered.setIntentOwner(p.id,2500);
  const ok=await createStripeTestIntent(pool,recovered.client,operator,p.id);
  assert.equal(ok.intentId,recovered.getIntentId());
  assert.equal(recovered.calls[0]!.key,'m8-pi-'+p.id);
  const pending=await createPayment(pool,operator,{operationId:uuid(),
   orderRef:uuid(),customerRef:uuid(),amountCents:2500,currency:'MXN'});
  await fail(()=>createStripeTestIntent(pool,failing,operator,pending.id),
   'M8_STRIPE_NETWORK_UNCERTAIN');
  await pool.query('UPDATE tala_payments_v2.stripe_test_intents SET '+
   "lease_until=clock_timestamp()-interval '1 day',"+
   "operation_started_at=clock_timestamp()-interval '21 hours' "+
   'WHERE payment_id=$1::uuid',[pending.id]);
  await fail(()=>createStripeTestIntent(pool,recovered.client,operator,pending.id),
   'M8_STRIPE_RECONCILIATION_REQUIRED');
 }finally{await pool.end();}
});

test('M8 LAB2 rejects LIVE events and unbound/incorrect signed amounts',
 {skip:!enabled,timeout:80000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8});
 const provider=mockStripe();
 try{
  const p=await createPayment(pool,operator,{operationId:uuid(),
   orderRef:uuid(),customerRef:uuid(),amountCents:2000,currency:'MXN'});
  provider.setIntentOwner(p.id,2000);
  await createStripeTestIntent(pool,provider.client,operator,p.id);
  const live=signed({...stripeEvent('payment_intent.succeeded',
   intentObject(p.id,2000,'succeeded',provider.getIntentId())),livemode:true});
  await fail(()=>ingestStripeTestWebhook(pool,webhookSecret,live.raw,
   live.signature),'M8_STRIPE_LIVEMODE_FORBIDDEN');
  const other=signed(stripeEvent('payment_intent.succeeded',
   intentObject(uuid(),2000,'succeeded',provider.getIntentId())));
  await fail(()=>ingestStripeTestWebhook(pool,webhookSecret,other.raw,
   other.signature),'M8_STRIPE_UNBOUND_EVENT');
  const badAmount=signed(stripeEvent('payment_intent.succeeded',
   intentObject(p.id,2001,'succeeded',provider.getIntentId())));
  await fail(()=>ingestStripeTestWebhook(pool,webhookSecret,
   badAmount.raw,badAmount.signature),'M8_STRIPE_AMOUNT_MISMATCH');
  const failedAttempt=signed(stripeEvent('payment_intent.payment_failed',
   intentObject(p.id,2000,'requires_payment_method',provider.getIntentId())));
  const outcome=await ingestStripeTestWebhook(pool,webhookSecret,
   failedAttempt.raw,failedAttempt.signature);
  assert.equal(outcome.applied,false);
  assert.equal((await readPayment(pool,operator,p.id)).state,'pending');
  const canceled=signed(stripeEvent('payment_intent.canceled',
   intentObject(p.id,2000,'canceled',provider.getIntentId())));
  await ingestStripeTestWebhook(pool,webhookSecret,canceled.raw,
   canceled.signature);
  assert.equal((await readPayment(pool,operator,p.id)).state,'canceled');
  const late=signed(stripeEvent('payment_intent.succeeded',
   intentObject(p.id,2000,'succeeded',provider.getIntentId())));
  await fail(()=>ingestStripeTestWebhook(pool,webhookSecret,late.raw,
   late.signature),'M8_EVENT_STATE_CONFLICT');
 }finally{await pool.end();}
});
