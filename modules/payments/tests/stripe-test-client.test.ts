import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {randomUUID} from 'node:crypto';
import {PaymentError} from '../src/domain.js';
import {StripeTestClient} from '../src/stripe-test-client.js';
import {verifyStripeTestSignature} from '../src/stripe-test-webhook.js';

const key='sk_test_M8_OFFLINE_FIXTURE_NO_NETWORK_1234';
const secret='whsec_M8_OFFLINE_FIXTURE_NO_NETWORK_1234';
const pi='pi_1234TestOnly0987654321',ref='re_1234TestOnly9876543210';
const id=()=>randomUUID();
const fail=(fn:()=>unknown,code:string)=>assert.throws(fn,
 e=>e instanceof PaymentError&&e.code===code);
const reject=(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,
 e=>e instanceof PaymentError&&e.code===code);

test('M8 Stripe TEST client rejects LIVE API keys and unexpected network origins',()=>{
 fail(()=>new StripeTestClient({apiKey:'sk_live_M8_NEVER_USE_REAL_MONEY_1234'}),
  'M8_STRIPE_TEST_KEY_REQUIRED');
 fail(()=>new StripeTestClient({apiKey:'rk_test_abcabcabcabcabc'}),
  'M8_STRIPE_TEST_KEY_REQUIRED');
 fail(()=>new StripeTestClient({apiKey:'sk_test_'}),
  'M8_STRIPE_TEST_KEY_REQUIRED');
 const client=new StripeTestClient({apiKey:key,transport:async()=>new Response('{}')});
 assert.ok(client);
});

test('M8 Stripe TEST client pins endpoint, form fields, idempotency and validates PI',async()=>{
 const paymentId=id();let count=0;
 const calls:Array<{url:string,method:string,auth:string,
  key:string,fields:URLSearchParams,version:string}>=[];
 const client=new StripeTestClient({apiKey:key,transport:async(url,init)=>{
  count++;
  const headers=new Headers(init?.headers);
  calls.push({url:String(url),method:String(init?.method),
   auth:String(headers.get('authorization')),
   key:String(headers.get('idempotency-key')),
   version:String(headers.get('stripe-version')),
   fields:new URLSearchParams(String(init?.body??''))});
  return new Response(JSON.stringify({
   id:pi,object:'payment_intent',livemode:false,amount:49900,
   currency:'mxn',status:'requires_payment_method',
   metadata:{m8_payment_id:paymentId},
   client_secret:pi+'_secret_OFFLINE_FIXTURE'
  }),{status:200});
 }});
 const result=await client.createIntent({paymentId,amountCents:49900,
  idempotencyKey:'m8-pi-'+paymentId});
 assert.equal(result.id,pi);
 assert.equal(result.livemode,false);
 assert.equal(result.client_secret,pi+'_secret_OFFLINE_FIXTURE');
 assert.equal(count,1);
 assert.equal(calls[0]!.url,'https://api.stripe.com/v1/payment_intents');
 assert.equal(calls[0]!.method,'POST');
 assert.equal(calls[0]!.auth,'Bearer '+key);
 assert.equal(calls[0]!.key,'m8-pi-'+paymentId);
 assert.equal(calls[0]!.version,'2026-10-28.endive');
 assert.equal(calls[0]!.fields.get('currency'),'mxn');
 assert.equal(calls[0]!.fields.get('amount'),'49900');
 assert.equal(calls[0]!.fields.get('metadata[m8_payment_id]'),paymentId);
 assert.deepEqual(calls[0]!.fields.getAll('payment_method_types[]'),['card']);
 assert.equal(calls[0]!.fields.has('confirm'),false);
 await reject(()=>client.createIntent({paymentId,amountCents:49900,
  idempotencyKey:'unsafe-random'}),'M8_STRIPE_KEY_INVALID');
 assert.equal(count,1);
});

test('M8 Stripe TEST client refuses live, mismatched amounts and metadata',async()=>{
 const paymentId=id();let calls=0;
 for(const change of [
  {livemode:true},{amount:200},{currency:'usd'},
  {metadata:{m8_payment_id:id()}},{object:'charge'}
 ]){
  const client=new StripeTestClient({apiKey:key,transport:async()=>{
   calls++;
   return new Response(JSON.stringify({id:pi,object:'payment_intent',
    livemode:false,amount:20000,currency:'mxn',
    status:'requires_payment_method',client_secret:null,
    metadata:{m8_payment_id:paymentId},...change}),{status:200});
  }});
  await reject(()=>client.createIntent({paymentId,amountCents:20000,
   idempotencyKey:'m8-pi-'+paymentId}),'M8_STRIPE_RESPONSE_INVALID');
 }
 assert.equal(calls,5);
});

test('M8 Stripe TEST refund call uses original PaymentIntent and guarded key',async()=>{
 const refundId=id();let captured='';
 const client=new StripeTestClient({apiKey:key,transport:async(_url,init)=>{
  captured=String(init?.body);
  return new Response(JSON.stringify({
   id:ref,object:'refund',livemode:false,amount:3000,currency:'mxn',
   status:'pending',payment_intent:pi,
   metadata:{m8_refund_id:refundId}
  }),{status:200});
 }});
 const result=await client.createRefund({refundId,intentId:pi,
  amountCents:3000,idempotencyKey:'m8-re-'+refundId});
 assert.equal(result.id,ref);
 assert.equal(result.livemode,false);
 const data=new URLSearchParams(captured);
 assert.equal(data.get('payment_intent'),pi);
 assert.equal(data.get('amount'),'3000');
 assert.equal(data.get('metadata[m8_refund_id]'),refundId);
});

test('M8 Stripe official signature accepts correct raw payload only, ignores other signatures',()=>{
 const body=Buffer.from(JSON.stringify({id:'evt_1234',type:'test',livemode:false}));
 const timestamp=String(Math.floor(Date.now()/1000));
 const digest=createHmac('sha256',secret).update(timestamp).update('.')
   .update(body).digest('hex');
 const header='t='+timestamp+',v1='+('0'.repeat(64))+',v1='+digest;
 assert.doesNotThrow(()=>verifyStripeTestSignature(secret,body,header));
 fail(()=>verifyStripeTestSignature(secret,Buffer.from('{"wrong":1}'),header),
  'M8_STRIPE_SIGNATURE_INVALID');
 fail(()=>verifyStripeTestSignature(secret,body,
  't='+String(Number(timestamp)-301)+',v1='+digest),
  'M8_STRIPE_SIGNATURE_INVALID');
 fail(()=>verifyStripeTestSignature(secret,body,'t='+timestamp+',v1=nothex'),
  'M8_STRIPE_SIGNATURE_INVALID');
 fail(()=>verifyStripeTestSignature('whsec_short',body,header),
  'M8_STRIPE_WEBHOOK_SECRET_INVALID');
});
