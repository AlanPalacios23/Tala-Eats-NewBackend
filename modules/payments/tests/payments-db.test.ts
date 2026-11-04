import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {PaymentError} from '../src/domain.js';
import {createPayment,requestRefund,readPayment} from '../src/payments.js';
import {ingestLabWebhook} from '../src/webhook.js';

const url=process.env.PAYMENTS_CI_URL??'';
const enabled=url.includes('/tala_payments_v2_test');
const id=()=>randomUUID();
const secret=randomBytes(32);
const customer=id();
const creator={actorId:id(),canCreatePayments:true,canReadPayments:true,
 canRefundPayments:true};
const noRights={actorId:id()};
const money=49900;
function sign(e:unknown,opts?:{timestamp?:string,secret?:Buffer}){
 const raw=Buffer.from(JSON.stringify(e));
 const timestamp=opts?.timestamp??String(Math.floor(Date.now()/1000));
 const key=opts?.secret??secret;
 const signature='v1='+createHmac('sha256',key).update(timestamp).update('.')
  .update(raw).digest('hex');
 return {raw,timestamp,signature};
}
const fail=(task:()=>Promise<unknown>,code:string)=>assert.rejects(task,
 (e:unknown)=>e instanceof PaymentError&&e.code===code);
const event=(kind:string,paymentId:string,amountCents:number,extra:Record<string,unknown>={})=>
 ({eventId:id(),kind,paymentId,amountCents,currency:'MXN',...extra});

test('M8 LAB: payment event lifecycle, verified facts and HMAC are deterministic',
 {skip:!enabled,timeout:80000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 try{
  const create={operationId:id(),orderRef:id(),customerRef:customer,
   amountCents:money,currency:'MXN' as const};
  await fail(()=>createPayment(pool,noRights,create),'M8_FORBIDDEN');
  const payment=await createPayment(pool,creator,create);
  assert.equal(payment.state,'pending');
  assert.equal((await createPayment(pool,creator,create)).replayed,true);
  await fail(()=>createPayment(pool,creator,{...create,amountCents:30000}),
   'M8_IDEMPOTENCY_CONFLICT');
  await fail(()=>createPayment(pool,creator,{...create,operationId:id()}),
   'M8_ORDER_PAYMENT_EXISTS');
  assert.equal((await readPayment(pool,creator,payment.id)).state,'pending');
  await fail(()=>readPayment(pool,noRights,payment.id),'M8_FORBIDDEN');
  await fail(()=>requestRefund(pool,creator,{operationId:id(),paymentId:payment.id,
   amountCents:1000}),'M8_PAYMENT_NOT_SETTLED');
  const accepted=event('payment.succeeded',payment.id,money,{
   providerRef:'lab_payment_'+id().replaceAll('-','').slice(0,16)});
  const wrongAmount={...accepted,eventId:id(),amountCents:money-1};
  const bad=sign(wrongAmount);
  await fail(()=>ingestLabWebhook(pool,secret,bad.raw,bad.timestamp,bad.signature),
   'M8_WEBHOOK_AMOUNT_MISMATCH');
  const ok=sign(accepted);
  const result=await ingestLabWebhook(pool,secret,ok.raw,ok.timestamp,ok.signature);
  assert.equal(result.applied,true);
  assert.equal((await ingestLabWebhook(pool,secret,ok.raw,ok.timestamp,
   ok.signature)).replayed,true);
  const record=await readPayment(pool,creator,payment.id);
  assert.equal(record.state,'succeeded');
  assert.equal(record.version,2);
  assert.equal(record.providerRef,accepted.providerRef);
  assert.equal(record.facts.length,1);
  assert.equal(record.facts[0]!.type,'FundsConfirmed.v1');
  assert.equal(record.facts[0]!.amountCents,money);
  assert.equal(record.facts[0]!.source,'simulated_lab');
  await fail(()=>ingestLabWebhook(pool,secret,Buffer.from(ok.raw.toString().replace(
   'payment.succeeded','payment.canceled')),ok.timestamp,ok.signature),
   'M8_WEBHOOK_SIGNATURE_INVALID');
  const stale=sign(accepted,{timestamp:String(Math.floor(Date.now()/1000)-500)});
  await fail(()=>ingestLabWebhook(pool,secret,stale.raw,stale.timestamp,
   stale.signature),'M8_WEBHOOK_TIMESTAMP_INVALID');
  const conflicting=sign({...accepted,amountCents:money-1});
  await fail(()=>ingestLabWebhook(pool,secret,conflicting.raw,conflicting.timestamp,
   conflicting.signature),'M8_WEBHOOK_REPLAY_CONFLICT');
  const lateFailure=sign(event('payment.failed',payment.id,money));
  await fail(()=>ingestLabWebhook(pool,secret,lateFailure.raw,
   lateFailure.timestamp,lateFailure.signature),'M8_EVENT_STATE_CONFLICT');
  assert.equal((await readPayment(pool,creator,payment.id)).facts.length,1);
  const e=await pool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_payments_v2.provider_events '+
   'WHERE payment_id=$1::uuid',[payment.id]);
  assert.equal(e.rows[0]!.n,1);
  await assert.rejects(pool.query('DELETE FROM tala_payments_v2.provider_events '+
   'WHERE payment_id=$1::uuid',[payment.id]),/IMMUTABLE/);
  await assert.rejects(pool.query('DELETE FROM tala_payments_v2.verified_facts '+
   'WHERE payment_id=$1::uuid',[payment.id]),/IMMUTABLE/);
 }finally{await pool.end();}
});
test('M8 LAB: fractional refunds and concurrent reservations cannot exceed paid amount',
 {skip:!enabled,timeout:80000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:16});
 try{
  const p=await createPayment(pool,creator,{operationId:id(),orderRef:id(),
   customerRef:customer,amountCents:10000,currency:'MXN'});
  const paid=sign(event('payment.succeeded',p.id,10000,{
   providerRef:'lab_paid_'+id().replaceAll('-','').slice(0,16)}));
  await ingestLabWebhook(pool,secret,paid.raw,paid.timestamp,paid.signature);
  const attempts=await Promise.allSettled(Array.from({length:6},()=>
   requestRefund(pool,creator,{operationId:id(),paymentId:p.id,amountCents:7000})));
  const success=attempts.filter(x=>x.status==='fulfilled');
  const failCount=attempts.filter(x=>x.status==='rejected');
  assert.equal(success.length,1);
  assert.equal(failCount.length,5);
  assert.ok(failCount.every(x=>x.status==='rejected'&&
   x.reason instanceof PaymentError&&x.reason.code==='M8_REFUND_EXCEEDS_PAYMENT'));
  const first=(success[0] as PromiseFulfilledResult<{id:string}>).value;
  await fail(()=>requestRefund(pool,noRights,{operationId:id(),
   paymentId:p.id,amountCents:100}),'M8_FORBIDDEN');
  const remainder=await requestRefund(pool,creator,{
   operationId:id(),paymentId:p.id,amountCents:3000});
  await fail(()=>requestRefund(pool,creator,{operationId:id(),
   paymentId:p.id,amountCents:1}),'M8_REFUND_EXCEEDS_PAYMENT');
  const invalid=sign(event('refund.succeeded',p.id,7001,{
   refundId:first.id,providerRef:'lab_refund_'+id().replaceAll('-','').slice(0,12)}));
  await fail(()=>ingestLabWebhook(pool,secret,invalid.raw,invalid.timestamp,
   invalid.signature),'M8_WEBHOOK_AMOUNT_MISMATCH');
  const firstRefund=sign(event('refund.succeeded',p.id,7000,{
   refundId:first.id,providerRef:'lab_refund_'+id().replaceAll('-','').slice(0,12)}));
  await ingestLabWebhook(pool,secret,firstRefund.raw,firstRefund.timestamp,
   firstRefund.signature);
  const failed=sign(event('refund.failed',p.id,3000,{refundId:remainder.id}));
  await ingestLabWebhook(pool,secret,failed.raw,failed.timestamp,failed.signature);
  const replacement=await requestRefund(pool,creator,{
   operationId:id(),paymentId:p.id,amountCents:3000});
  const last=sign(event('refund.succeeded',p.id,3000,{
   refundId:replacement.id,providerRef:'lab_refund_'+id().replaceAll('-','').slice(0,12)}));
  await ingestLabWebhook(pool,secret,last.raw,last.timestamp,last.signature);
  await fail(()=>requestRefund(pool,creator,{operationId:id(),paymentId:p.id,
   amountCents:1}),'M8_REFUND_EXCEEDS_PAYMENT');
  const read=await readPayment(pool,creator,p.id);
  assert.equal(read.refunds.length,3);
  assert.equal(read.refunds.filter(x=>x.state==='succeeded').reduce((sum,x)=>
   sum+x.amountCents,0),10000);
  assert.equal(read.facts.length,3);
  assert.equal(read.facts.filter(x=>x.type==='ProviderRefundConfirmed.v1')
   .reduce((sum,x)=>sum+x.amountCents,0),10000);
 }finally{await pool.end();}
});
test('M8 LAB: terminal failed payments never create settlement facts or refunds',
 {skip:!enabled,timeout:60000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8});
 try{
  const p=await createPayment(pool,creator,{operationId:id(),orderRef:id(),
   customerRef:customer,amountCents:2500,currency:'MXN'});
  const failed=sign(event('payment.failed',p.id,2500));
  await ingestLabWebhook(pool,secret,failed.raw,failed.timestamp,failed.signature);
  assert.equal((await readPayment(pool,creator,p.id)).state,'failed');
  assert.equal((await readPayment(pool,creator,p.id)).facts.length,0);
  await fail(()=>requestRefund(pool,creator,{operationId:id(),paymentId:p.id,
   amountCents:100}),'M8_PAYMENT_NOT_SETTLED');
  const delayed=sign(event('payment.succeeded',p.id,2500,{
   providerRef:'lab_late_'+id().replaceAll('-','').slice(0,12)}));
  await fail(()=>ingestLabWebhook(pool,secret,delayed.raw,delayed.timestamp,
   delayed.signature),'M8_EVENT_STATE_CONFLICT');
 }finally{await pool.end();}
});
