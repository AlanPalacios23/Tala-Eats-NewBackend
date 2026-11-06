import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {AnalyticsError,EVENT_ISSUERS,signAnalyticsEvent,
 type AnalyticsEvent,type IssuerKeys} from '../src/contract.js';
import {ingestAnalyticsEvent,merchantAnalytics,platformAnalytics,
 type AnalyticsConfig} from '../src/analytics.js';

const url=process.env.ANALYTICS_CI_URL??'';
const enabled=/\/tala_analytics_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
const time=()=>new Date(Math.floor(Date.now()/1000)*1000)
 .toISOString().replace('.000Z','Z');
const day=()=>time().slice(0,10);
const keys:IssuerKeys={
 orders:{ops01:randomBytes(32)},payments:{ops01:randomBytes(32)},
 logistics:{ops01:randomBytes(32)}
};
function event(kind:AnalyticsEvent['kind'],merchantId:string,orderId:string,
 amountCents:number,refundId:string|null=null):AnalyticsEvent{
 return {eventId:id(),kind,merchantId,orderId,refundId,amountCents,
  occurredAt:time()};
}
function signed(pool:pg.Pool,e:AnalyticsEvent):{
 config:AnalyticsConfig,input:{raw:Buffer,issuer:typeof EVENT_ISSUERS[typeof e.kind],
  kid:string,signature:string}
}{
 const raw=Buffer.from(JSON.stringify(e));
 const issuer=EVENT_ISSUERS[e.kind];
 return {config:{pool,keys},input:{raw,issuer,kid:'ops01',
  signature:signAnalyticsEvent(raw,issuer,'ops01',keys)}};
}
async function ingest(pool:pg.Pool,e:AnalyticsEvent){
 const s=signed(pool,e);
 return ingestAnalyticsEvent(s.config,s.input);
}
const fail=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,
 e=>e instanceof AnalyticsError&&e.code===code);
const viewer=(merchantId:string)=>({
 actorId:id(),authenticated:true,merchantId,canReadMerchantAnalytics:true
});
test('M10 LAB signed event cycle creates correct daily analytics and zero personal data',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:14});
 try{
  const m=id(),o=id(),refund1=id(),refund2=id();
  const payment=event('payment.confirmed',m,o,49900);
  const result=await ingest(pool,payment);
  assert.equal(result.applied,true);
  assert.equal(result.duplicate,false);
  const same=await ingest(pool,payment);
  assert.equal(same.duplicate,true);
  await ingest(pool,event('order.completed',m,o,55000));
  await ingest(pool,event('delivery.completed',m,o,0));
  await ingest(pool,event('refund.confirmed',m,o,10000,refund1));
  await ingest(pool,event('refund.confirmed',m,o,39000,refund2));
  const report=await merchantAnalytics(pool,viewer(m),m,day(),day());
  assert.equal(report.derivedNotLedger,true);
  assert.equal(report.days.length,1);
  assert.equal(report.totals.ordersCompleted,'1');
  assert.equal(report.totals.deliveriesCompleted,'1');
  assert.equal(report.totals.paymentsConfirmed,'1');
  assert.equal(report.totals.refundsConfirmed,'2');
  assert.equal(report.totals.orderGmvCents,'55000');
  assert.equal(report.totals.paymentsCents,'49900');
  assert.equal(report.totals.refundsCents,'49000');
  assert.equal(report.totals.netPaymentFlowCents,'900');
  assert.equal(report.days[0]?.date,day());
  assert.equal(Object.hasOwn(report,'customerId'),false);
  const stored=await pool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_analytics_v2.ingested_events '+
   'WHERE merchant_id=$1::uuid',[m]);
  assert.equal(stored.rows[0]?.n,5);
  await assert.rejects(pool.query('DELETE FROM tala_analytics_v2.ingested_events '+
   'WHERE event_id=$1::uuid',[payment.eventId]),/ANALYTICS_FACT_IMMUTABLE/);
 }finally{await pool.end();}
});

test('M10 LAB rejects inflated analytics by business ID, merchant collision or refund over-capture',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 try{
  const m=id(),other=id(),o=id();
  const completed=event('order.completed',m,o,10000);
  await ingest(pool,completed);
  await fail(ingest(pool,event('order.completed',m,o,15000)),
   'M10_BUSINESS_EVENT_CONFLICT');
  await fail(ingest(pool,event('order.canceled',m,o,0)),
   'M10_BUSINESS_EVENT_CONFLICT');
  await fail(ingest(pool,event('delivery.completed',other,o,0)),
   'M10_MERCHANT_ORDER_CONFLICT');
  await fail(ingest(pool,event('refund.confirmed',m,o,500,id())),
   'M10_MISSING_PAYMENT_FACT');
  const paid=event('payment.confirmed',m,o,9000);
  await ingest(pool,paid);
  await fail(ingest(pool,event('payment.confirmed',m,o,9000)),
   'M10_BUSINESS_EVENT_CONFLICT');
  await ingest(pool,event('refund.confirmed',m,o,7000,id()));
  await fail(ingest(pool,event('refund.confirmed',m,o,2001,id())),
   'M10_REFUND_EXCEEDS_CAPTURE');
  const secondRefund=id();
  const first=event('refund.confirmed',m,o,1000,secondRefund);
  await ingest(pool,first);
  await fail(ingest(pool,event('refund.confirmed',m,o,1000,secondRefund)),
   'M10_BUSINESS_EVENT_CONFLICT');
  const tampered={...completed,amountCents:10001};
  await fail(ingest(pool,tampered),'M10_EVENT_ID_CONFLICT');
  const report=await merchantAnalytics(pool,viewer(m),m,day(),day());
  assert.equal(report.totals.ordersCompleted,'1');
  assert.equal(report.totals.paymentsConfirmed,'1');
  assert.equal(report.totals.refundsConfirmed,'2');
  assert.equal(report.totals.refundsCents,'8000');
 }finally{await pool.end();}
});
test('M10 LAB 20 identical concurrent signed events only affect rollup once',
 {skip:!enabled,timeout:95000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:24});
 try{
  const m=id(),o=id(),e=event('order.completed',m,o,23900);
  const {config,input}=signed(pool,e);
  const results=await Promise.all(Array.from({length:20},()=>
   ingestAnalyticsEvent(config,input)));
  assert.equal(results.filter(x=>x.applied).length,1);
  assert.equal(results.filter(x=>x.duplicate).length,19);
  const report=await merchantAnalytics(pool,viewer(m),m,day(),day());
  assert.equal(report.totals.ordersCompleted,'1');
  assert.equal(report.totals.orderGmvCents,'23900');
 }finally{await pool.end();}
});
test('M10 LAB merchant read cannot access other stores, platform aggregates need host role',
 {skip:!enabled,timeout:85000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:14});
 try{
  const a=id(),b=id();
  await ingest(pool,event('order.completed',a,id(),16000));
  await ingest(pool,event('order.canceled',b,id(),0));
  const ma=await merchantAnalytics(pool,viewer(a),a,day(),day());
  assert.equal(ma.totals.ordersCompleted,'1');
  assert.equal(ma.totals.ordersCanceled,'0');
  await fail(merchantAnalytics(pool,viewer(a),b,day(),day()),'M10_FORBIDDEN');
  await fail(merchantAnalytics(pool,{
   actorId:id(),authenticated:false,merchantId:a,
   canReadMerchantAnalytics:true},a,day(),day()),'M10_FORBIDDEN');
  await fail(platformAnalytics(pool,{actorId:id(),authenticated:true},day(),day()),
   'M10_FORBIDDEN');
  const summary=await platformAnalytics(pool,{
   actorId:id(),authenticated:true,canReadPlatformAnalytics:true
  },day(),day());
  assert.equal(summary.scope,'platform');
  assert.ok(BigInt(summary.totals.ordersCompleted)>=1n);
  assert.ok(BigInt(summary.totals.ordersCanceled)>=1n);
  await fail(platformAnalytics(pool,{
   actorId:id(),authenticated:true,canReadPlatformAnalytics:true
  },'2020-01-01','2026-11-05'),'M10_REPORT_RANGE_INVALID');
  await fail(merchantAnalytics(pool,viewer(a),a,'2026-02-31',day()),
   'M10_REPORT_RANGE_INVALID');
 }finally{await pool.end();}
});
