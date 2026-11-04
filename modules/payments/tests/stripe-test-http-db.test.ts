import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {createPaymentsLabHttpServer} from '../src/http-lab.js';
import {StripeTestClient} from '../src/stripe-test-client.js';

const url=process.env.PAYMENTS_CI_URL??'',
 enabled=url.includes('/tala_payments_v2_test'),
 id=()=>randomUUID();
const token='Bearer m8-stripe-test-'+id(),
 whsec='whsec_M8_TEST_ONLY_HTTP_FIXTURE_9876543210',
 key='sk_test_M8_TEST_ONLY_HTTP_FIXTURE_9876543210';
const piId='pi_'+randomBytes(16).toString('hex'),
 refundId='re_'+randomBytes(16).toString('hex');

test('M8 LAB2 TEST-only HTTP API: host permissions, PaymentIntent, refunds and native Stripe-Signature',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:10});
 let count=0;
 const client=new StripeTestClient({apiKey:key,transport:async(endpoint,init)=>{
  count++;
  const body=new URLSearchParams(String(init?.body??'')),
    path=String(endpoint);
  if(path.endsWith('/v1/payment_intents'))
   return new Response(JSON.stringify({
    id:piId,object:'payment_intent',livemode:false,amount:Number(body.get('amount')),
    currency:'mxn',metadata:{m8_payment_id:body.get('metadata[m8_payment_id]')},
    client_secret:piId+'_secret_OFFLINE',status:'requires_payment_method'
   }),{status:200});
  if(path.endsWith('/v1/refunds'))
   return new Response(JSON.stringify({
    id:refundId,object:'refund',amount:Number(body.get('amount')),
    currency:'mxn',payment_intent:piId,
    metadata:{m8_refund_id:body.get('metadata[m8_refund_id]')},
    status:'pending'
   }),{status:200});
  if(path.includes('/v1/payment_intents/'))
   return new Response(JSON.stringify({
    id:piId,object:'payment_intent',livemode:false,amount:49900,
    currency:'mxn',metadata:{m8_payment_id:paymentId},
    client_secret:piId+'_secret_OFFLINE',status:'succeeded'
   }),{status:200});
  return new Response('{}',{status:404});
 }});
 const actor={actorId:id(),canCreatePayments:true,canRefundPayments:true,
  canReadPayments:true},denied={actorId:id()};
 const server=createPaymentsLabHttpServer({pool,webhookSecret:randomBytes(32),
  stripeTest:{client,webhookSecret:whsec},
  authenticate:async req=>req.headers.authorization===token?actor:
   req.headers.authorization==='Bearer denied'?denied:null});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 const paymentIdHolder:{value:string}={value:''};
 // Initialized before the mocked retrieve path is first called.
 const paymentId=paymentIdHolder.value;
 async function call(method:string,path:string,body?:unknown,
  headers:Record<string,string>={}){
  const r=await fetch(base+path,{method,headers:{
   authorization:token,...(body!==undefined?{'content-type':'application/json'}:{}),
   ...headers
  },...(body===undefined?{}:{body:typeof body==='string'?body:
   JSON.stringify(body)})});
  return {status:r.status,body:await r.json() as Record<string,any>,
   cache:r.headers.get('cache-control')};
 }
 const sign=(event:unknown)=>{
  const body=JSON.stringify(event),ts=String(Math.floor(Date.now()/1000)),
   hmac=createHmac('sha256',whsec).update(ts).update('.')
    .update(body).digest('hex');
  return {body,header:'t='+ts+',v1='+hmac};
 };
 try{
  const p=await call('POST','/v1/payments',{operationId:id(),
   orderRef:id(),customerRef:id(),amountCents:49900,currency:'MXN'});
  assert.equal(p.status,201);
  paymentIdHolder.value=String(p.body.id);
  const pid=paymentIdHolder.value;
  assert.equal((await call('POST','/v1/payments/'+pid+'/stripe-test-intent',
   {},{authorization:'Bearer denied'})).status,403);
  const opened=await call('POST','/v1/payments/'+pid+'/stripe-test-intent',{});
  assert.equal(opened.status,200);
  assert.equal(opened.body.intentId,piId);
  assert.equal(opened.body.livemode,false);
  assert.equal(count,1);
  assert.equal((await call('POST','/v1/payments/stripe-test-webhook',
   {id:'evt_unauth'},{})).status,401);
  const paymentEvt={id:'evt_'+randomBytes(12).toString('hex'),
   type:'payment_intent.succeeded',livemode:false,
   data:{object:{id:piId,object:'payment_intent',livemode:false,
    amount:49900,amount_received:49900,currency:'mxn',
    status:'succeeded',metadata:{m8_payment_id:pid}}}};
  const signedPay=sign(paymentEvt);
  const settled=await call('POST','/v1/payments/stripe-test-webhook',
   signedPay.body,{'stripe-signature':signedPay.header});
  assert.equal(settled.status,200);
  assert.equal(settled.body.applied,true);
  const read=await call('GET','/v1/payments/'+pid);
  assert.equal(read.body.state,'succeeded');
  assert.equal(read.cache,'private, no-store');
  const refund=await call('POST','/v1/payments/'+pid+'/refunds',{
   operationId:id(),amountCents:9000});
  assert.equal(refund.status,201);
  const rid=String(refund.body.id);
  assert.equal((await call('POST','/v1/payments/'+id()+
   '/refunds/'+rid+'/stripe-test-send',{})).status,404);
  const sent=await call('POST','/v1/payments/'+pid+
   '/refunds/'+rid+'/stripe-test-send',{});
  assert.equal(sent.status,200);
  assert.equal(sent.body.stripeRefundId,refundId);
  const refundEvt={id:'evt_'+randomBytes(12).toString('hex'),
   type:'refund.updated',livemode:false,
   data:{object:{id:refundId,object:'refund',amount:9000,
    currency:'mxn',status:'succeeded',payment_intent:piId,
    metadata:{m8_refund_id:rid}}}};
  const signedRefund=sign(refundEvt);
  assert.equal((await call('POST','/v1/payments/stripe-test-webhook',
   signedRefund.body,{'stripe-signature':signedRefund.header})).status,200);
  const after=await call('GET','/v1/payments/'+pid);
  assert.equal(after.body.refunds[0]!.state,'succeeded');
 }finally{
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  await pool.end();
 }
});
