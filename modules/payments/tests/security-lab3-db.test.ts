import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {PaymentError} from '../src/domain.js';
import {createPayment,readPayment,requestRefund} from '../src/payments.js';
import {createStripeTestIntent,sendStripeTestRefund} from '../src/stripe-test-operations.js';
import {StripeTestClient} from '../src/stripe-test-client.js';
import {ingestStripeTestWebhook} from '../src/stripe-test-webhook.js';

const url=process.env.PAYMENTS_CI_URL??'';
const enabled=/\/tala_payments_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
const stripeSecret='whsec_M8_LAB3_TEST_EVENTS_HMAC_12345';
const key='sk_test_M8_LAB3_TEST_ONLY_NO_NETWORK_12345';
const fail=(run:()=>Promise<unknown>,code:string)=>assert.rejects(run,
 e=>e instanceof PaymentError&&e.code===code);
const apiMock=(pi:string,re:string)=>new StripeTestClient({
 apiKey:key,transport:async(url,init)=>{
  const params=new URLSearchParams(String(init?.body??''));
  if(String(url).endsWith('/v1/payment_intents')){
   return new Response(JSON.stringify({id:pi,object:'payment_intent',livemode:false,
    amount:Number(params.get('amount')),currency:'mxn',
    status:'requires_payment_method',client_secret:pi+'_secret_test',
    metadata:{m8_payment_id:params.get('metadata[m8_payment_id]')}}));
  }
  if(String(url).includes('/v1/payment_intents/')){
   return new Response(JSON.stringify({id:pi,object:'payment_intent',livemode:false,
    amount:10000,currency:'mxn',status:'succeeded',client_secret:null,
    metadata:{m8_payment_id:''}}));
  }
  if(String(url).endsWith('/v1/refunds')){
   return new Response(JSON.stringify({id:re,object:'refund',
    amount:Number(params.get('amount')),currency:'mxn',
    payment_intent:params.get('payment_intent'),status:'pending',
    metadata:{m8_refund_id:params.get('metadata[m8_refund_id]')}}));
  }
  return new Response('{}',{status:404});
 }
});
function signed(type:string,object:Record<string,unknown>){
 const raw=Buffer.from(JSON.stringify({
  id:'evt_'+randomBytes(16).toString('hex'),type,livemode:false,
  data:{object}
 }));
 const ts=String(Math.floor(Date.now()/1000));
 const signature='t='+ts+',v1='+createHmac('sha256',stripeSecret)
  .update(ts).update('.').update(raw).digest('hex');
 return {raw,signature};
}
function piObject(paymentId:string,pi:string,status:string,received=10000){
 return {id:pi,object:'payment_intent',livemode:false,
  amount:10000,amount_received:received,currency:'mxn',status,
  metadata:{m8_payment_id:paymentId}};
}
test('M8 LAB3 payment reads enforce authenticated customer owner or explicit audit privilege',
 {skip:!enabled,timeout:65000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8});
 const customer={actorId:id(),canReadPayments:true},other={
  actorId:id(),canReadPayments:true},operator={actorId:id(),
  canCreatePayments:true,canReadPayments:true,canReadAllPayments:true};
 try{
  const pay=await createPayment(pool,operator,{operationId:id(),
   orderRef:id(),customerRef:customer.actorId,
   amountCents:15000,currency:'MXN'});
  const mine=await readPayment(pool,customer,pay.id);
  assert.equal(mine.customerRef,customer.actorId);
  await fail(()=>readPayment(pool,other,pay.id),'M8_PAYMENT_NOT_FOUND');
  assert.equal((await readPayment(pool,operator,pay.id)).id,pay.id);
  await fail(()=>readPayment(pool,{actorId:id(),
   canReadAllPayments:true},pay.id),'M8_FORBIDDEN');
  assert.equal((await pool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_payments_v2.audit '+
   "WHERE entity_id=$1::uuid AND action='payment.create'",
   [pay.id])).rows[0]!.n,1);
 }finally{await pool.end();}
});

test('M8 LAB3 rejects signed Stripe failure events inconsistent with provider state',
 {skip:!enabled,timeout:75000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8});
 const pi='pi_'+randomBytes(16).toString('hex'),
  re='re_'+randomBytes(16).toString('hex'),
  operator={actorId:id(),canCreatePayments:true,
   canReadPayments:true,canReadAllPayments:true,
   canRefundPayments:true};
 const gateway=apiMock(pi,re);
 try{
  const payment=await createPayment(pool,operator,{operationId:id(),
   orderRef:id(),customerRef:id(),amountCents:10000,currency:'MXN'});
  await createStripeTestIntent(pool,gateway,operator,payment.id);
  const wrongFailure=signed('payment_intent.payment_failed',
   piObject(payment.id,pi,'succeeded'));
  await fail(()=>ingestStripeTestWebhook(pool,stripeSecret,
   wrongFailure.raw,wrongFailure.signature),'M8_STRIPE_WEBHOOK_INVALID');
  assert.equal((await readPayment(pool,operator,payment.id)).state,'pending');
  const success=signed('payment_intent.succeeded',
   piObject(payment.id,pi,'succeeded'));
  await ingestStripeTestWebhook(pool,stripeSecret,success.raw,success.signature);
  const requested=await requestRefund(pool,operator,{
   operationId:id(),paymentId:payment.id,amountCents:4000});
  await sendStripeTestRefund(pool,gateway,operator,requested.id);
  const wrongRefund=signed('refund.failed',{
   id:re,object:'refund',amount:4000,currency:'mxn',
   status:'succeeded',payment_intent:pi,
   metadata:{m8_refund_id:requested.id}
  });
  await fail(()=>ingestStripeTestWebhook(pool,stripeSecret,
   wrongRefund.raw,wrongRefund.signature),'M8_STRIPE_WEBHOOK_INVALID');
  const pending=(await readPayment(pool,operator,payment.id));
  assert.equal(pending.refunds[0]!.state,'requested');
  assert.equal(pending.stripeTestFacts.length,1);
  const failedRefund=signed('refund.failed',{
   id:re,object:'refund',amount:4000,currency:'mxn',
   status:'failed',payment_intent:pi,
   metadata:{m8_refund_id:requested.id}
  });
  const applied=await ingestStripeTestWebhook(pool,stripeSecret,
   failedRefund.raw,failedRefund.signature);
  assert.equal(applied.applied,true);
  assert.equal((await readPayment(pool,operator,payment.id)).refunds[0]!.state,
   'failed');
  assert.equal((await readPayment(pool,operator,payment.id)).stripeTestFacts.length,1,
   'Failed refund must not create a ProviderRefundConfirmed fact');
 }finally{await pool.end();}
});
