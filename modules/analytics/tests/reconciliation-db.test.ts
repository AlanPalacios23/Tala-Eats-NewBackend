import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {AnalyticsError,signAnalyticsEvent,
 type AnalyticsEvent,type IssuerKeys} from '../src/contract.js';
import {ingestAnalyticsEvent,merchantAnalytics} from '../src/analytics.js';
import {reconcileMerchantDay} from '../src/reconciliation.js';

const url=process.env.ANALYTICS_CI_URL??'';
const enabled=/\/tala_analytics_v2_test(?:$|\?)/.test(url);
const keys:IssuerKeys={
 orders:{write01:randomBytes(32)},payments:{write01:randomBytes(32)},
 logistics:{write01:randomBytes(32)}
};
const id=()=>randomUUID();
const at=()=>new Date(Math.floor(Date.now()/1000)*1000)
 .toISOString().replace('.000Z','Z');
const day=()=>at().slice(0,10);
const audited={authenticated:true,canAuditAnalytics:true};
const repaired={authenticated:true,canAuditAnalytics:true,
 canRepairAnalytics:true};
function event(merchantId:string,orderId:string,amountCents:number,
 eventId=id()):AnalyticsEvent{
 return {eventId,kind:'order.completed',merchantId,orderId,refundId:null,
  amountCents,occurredAt:at()};
}
async function ingest(pool:pg.Pool,e:AnalyticsEvent){
 const raw=Buffer.from(JSON.stringify(e));
 return ingestAnalyticsEvent({pool,keys},{raw,issuer:'orders',
  kid:'write01',signature:signAnalyticsEvent(raw,'orders','write01',keys)});
}
const fails=(p:Promise<unknown>,code:string)=>assert.rejects(p,
 e=>e instanceof AnalyticsError&&e.code===code);
test('M10 LAB rollup audit detects drift and privileged repair rebuilds derived counters',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 try{
  const m=id(),o=id();
  await ingest(pool,event(m,o,22000));
  const fine=await reconcileMerchantDay(pool,audited,m,day());
  assert.equal(fine.driftDetected,false);
  assert.equal(fine.repaired,false);
  await pool.query('UPDATE tala_analytics_v2.daily_merchant_metrics '+
   'SET orders_completed=50,order_gmv_cents=100000000 '+
   'WHERE merchant_id=$1::uuid AND event_day=$2::date',[m,day()]);
  const drift=await reconcileMerchantDay(pool,audited,m,day());
  assert.equal(drift.driftDetected,true);
  assert.equal(drift.repaired,false);
  assert.ok(drift.differingFields.includes('order_gmv_cents'));
  assert.equal(drift.expected.order_gmv_cents,'22000');
  assert.equal(drift.observed.order_gmv_cents,'100000000');
  await fails(reconcileMerchantDay(pool,{},m,day()),'M10_FORBIDDEN');
  await fails(reconcileMerchantDay(pool,audited,m,day(),'repair'),
   'M10_FORBIDDEN');
  const fix=await reconcileMerchantDay(pool,repaired,m,day(),'repair');
  assert.equal(fix.repaired,true);
  assert.equal((await reconcileMerchantDay(pool,audited,m,day()))
   .driftDetected,false);
  const report=await merchantAnalytics(pool,{
   authenticated:true,actorId:id(),merchantId:m,
   canReadMerchantAnalytics:true},m,day(),day());
  assert.equal(report.totals.ordersCompleted,'1');
  assert.equal(report.totals.orderGmvCents,'22000');
  const count=await pool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_analytics_v2.ingested_events '+
   'WHERE merchant_id=$1::uuid',[m]);
  assert.equal(count.rows[0]?.n,1,'repair must not create or delete raw events');
 }finally{await pool.end();}
});
test('M10 LAB parallel rollup repair and 15 independent events never lose a count',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:24});
 try{
  const merchant=id();
  const tasks=Array.from({length:15},()=>ingest(pool,event(merchant,id(),1000)));
  const operations=[...tasks,
   reconcileMerchantDay(pool,repaired,merchant,day(),'repair')];
  const outcomes=await Promise.all(operations);
  assert.equal(outcomes.length,16);
  const clean=await reconcileMerchantDay(pool,audited,merchant,day());
  assert.equal(clean.driftDetected,false);
  assert.equal(clean.expected.orders_completed,'15');
  assert.equal(clean.expected.order_gmv_cents,'15000');
 }finally{await pool.end();}
});
test('M10 LAB rejects event ID reuse across orders and fragmented merchant attribution',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:16});
 try{
  const merchant=id(),other=id(),one=id(),two=id(),sameId=id();
  const original=event(merchant,one,1000,sameId);
  const collision=event(merchant,two,2000,sameId);
  const results=await Promise.allSettled([
   ingest(pool,original),ingest(pool,collision)
  ]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  const denied=results.find(x=>x.status==='rejected');
  assert.ok(denied?.status==='rejected'&&
   denied.reason instanceof AnalyticsError&&
   denied.reason.code==='M10_EVENT_ID_CONFLICT');
  const paymentOrder=id();
  const payment:AnalyticsEvent={
   eventId:id(),kind:'payment.confirmed',merchantId:merchant,
   orderId:paymentOrder,refundId:null,amountCents:8000,occurredAt:at()
  };
  const raw=Buffer.from(JSON.stringify(payment));
  await ingestAnalyticsEvent({pool,keys},{issuer:'payments',kid:'write01',
   raw,signature:signAnalyticsEvent(raw,'payments','write01',keys)});
  await fails(ingest(pool,event(other,paymentOrder,8000)),
   'M10_MERCHANT_ORDER_CONFLICT');
 }finally{await pool.end();}
});
test('M10 LAB historical UTC date is preserved rather than silently shifted',
 {skip:!enabled,timeout:80000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8});
 try{
  const merchant=id(),historical=new Date(Date.now()-2*86_400_000)
   .toISOString().slice(0,10);
  const e={...event(merchant,id(),1900),
   occurredAt:historical+'T23:59:59Z'};
  await ingest(pool,e);
  const fine=await reconcileMerchantDay(pool,audited,merchant,historical);
  assert.equal(fine.driftDetected,false);
  assert.equal(fine.expected.order_gmv_cents,'1900');
 }finally{await pool.end();}
});
