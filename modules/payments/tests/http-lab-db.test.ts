import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID,randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {createPaymentsLabHttpServer} from '../src/http-lab.js';
import {PaymentError} from '../src/domain.js';
const url=process.env.PAYMENTS_CI_URL??'';
const enabled=url.includes('/tala_payments_v2_test');
const id=()=>randomUUID();
test('M8 LAB HTTP E2E: no public payment authority, forged roles or unsigned callbacks',
 {skip:!enabled,timeout:75000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:10}),secret=randomBytes(32);
 const owner='Bearer system-'+id(),customer='Bearer customer-'+id(),
  adminId=id(),customerId=id();
 const server=createPaymentsLabHttpServer({pool,webhookSecret:secret,
  authenticate:async req=>req.headers.authorization===owner?
   {actorId:adminId,canCreatePayments:true,canRefundPayments:true,
    canReadPayments:true}:
   req.headers.authorization===customer?{actorId:customerId}:null});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 async function call(method:string,path:string,token?:string,body?:unknown,
  headers:Record<string,string>={}){
  const r=await fetch(base+path,{method,headers:{
   ...(token?{authorization:token}:{}),
   ...(body!==undefined?{'content-type':'application/json'}:{}),...headers
  },...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
  return {status:r.status,body:await r.json() as Record<string,any>,
   cache:r.headers.get('cache-control'),cors:r.headers.get('access-control-allow-origin')};
 }
 try{
  const health=await call('GET','/v1/payments/health');
  assert.equal(health.status,200);
  assert.equal(health.body.realFunds,false);
  const input={operationId:id(),orderRef:id(),customerRef:id(),
   amountCents:49900,currency:'MXN'};
  assert.equal((await call('POST','/v1/payments',undefined,input)).status,401);
  assert.equal((await call('POST','/v1/payments',customer,
   {...input,canCreatePayments:true})).status,400);
  assert.equal((await call('POST','/v1/payments',customer,input)).status,403);
  const r=await call('POST','/v1/payments',owner,input);
  assert.equal(r.status,201);
  assert.equal(r.body.state,'pending');
  const idPayment=String(r.body.id);
  assert.equal((await call('GET','/v1/payments/'+idPayment,customer)).status,403);
  assert.equal((await call('POST','/v1/payments/'+idPayment+'/refunds',owner,
   {operationId:id(),amountCents:1000})).status,409);
  const webhook={eventId:id(),kind:'payment.succeeded',paymentId:idPayment,
   amountCents:49900,currency:'MXN',
   providerRef:'lab_mock_'+id().slice(0,12)};
  const raw=JSON.stringify(webhook),timestamp=String(Math.floor(Date.now()/1000));
  const signature='v1='+createHmac('sha256',secret).update(timestamp)
   .update('.').update(raw).digest('hex');
  assert.equal((await call('POST','/v1/payments/lab-webhook',undefined,
   raw,{'x-lab-timestamp':timestamp,'x-lab-signature':'v1='+'0'.repeat(64)}))
    .status,401);
  assert.equal((await call('POST','/v1/payments/lab-webhook',undefined,
   raw,{'x-lab-timestamp':timestamp,'x-lab-signature':signature})).status,200);
  const rep=await call('POST','/v1/payments/lab-webhook',undefined,
   raw,{'x-lab-timestamp':timestamp,'x-lab-signature':signature});
  assert.equal(rep.status,200);
  assert.equal(rep.body.replayed,true);
  const read=await call('GET','/v1/payments/'+idPayment,owner);
  assert.equal(read.body.state,'succeeded');
  assert.equal(read.body.facts.length,1);
  assert.equal(read.body.facts[0].source,'simulated_lab');
  assert.equal(read.cache,'private, no-store');
  assert.equal(read.cors,null);
  const ref=await call('POST','/v1/payments/'+idPayment+'/refunds',owner,
   {operationId:id(),amountCents:20000});
  assert.equal(ref.status,201);
  assert.equal((await call('POST','/v1/payments/'+idPayment+'/refunds',owner,
   {operationId:id(),amountCents:30000})).status,409);
  const refundEvent={eventId:id(),kind:'refund.succeeded',paymentId:idPayment,
   refundId:String(ref.body.id),amountCents:20000,currency:'MXN',
   providerRef:'lab_refund_'+id().slice(0,12)};
  const rr=JSON.stringify(refundEvent),
   h='v1='+createHmac('sha256',secret).update(timestamp).update('.')
    .update(rr).digest('hex');
  assert.equal((await call('POST','/v1/payments/lab-webhook',undefined,rr,
   {'x-lab-timestamp':timestamp,'x-lab-signature':h})).status,200);
  const after=await call('GET','/v1/payments/'+idPayment,owner);
  assert.equal(after.body.facts.length,2);
  assert.equal(after.body.refunds[0].state,'succeeded');
 }finally{
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  await pool.end();
 }
});
test('M8 HTTP LAB refuses server startup in production',()=>{
 const prev=process.env.NODE_ENV;
 try{
  process.env.NODE_ENV='production';
  const fake=new pg.Pool({connectionString:'postgresql://invalid'});
  assert.throws(()=>createPaymentsLabHttpServer({
   pool:fake,webhookSecret:randomBytes(32),authenticate:async()=>null
  }),e=>e instanceof PaymentError&&e.code==='M8_LAB_HTTP_DISABLED');
  void fake.end();
 }finally{
  if(prev===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=prev;
 }
});
