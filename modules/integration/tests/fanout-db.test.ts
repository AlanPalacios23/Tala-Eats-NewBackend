import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import pg from 'pg';
import {IntegrationError} from '../src/manifest.js';
import {acceptVerifiedEvent,claimJobs,settleJob,readDeliveryStats,
 type EventFact,type Issuer,type EventKind,type Target,
 type TrustedVerifier,type SignedEnvelope} from '../src/fanout.js';

const url=process.env.INTEGRATION_CI_URL??'';
const enabled=/\/tala_integration_v2_test(?:$|\?)/.test(url);
const upstream=join(process.cwd(),'.upstream','analytics','modules',
 'analytics','src','contract.ts');
const runTests=enabled&&(existsSync(upstream)||
 process.env.M11_REQUIRE_SOURCES==='1');
const id=()=>randomUUID();
const at=()=>new Date(Math.floor(Date.now()/1000)*1000)
 .toISOString().replace('.000Z','Z');
const domainIssuer:Record<EventKind,Issuer>={
 'order.completed':'orders','order.canceled':'orders',
 'payment.confirmed':'payments','refund.confirmed':'payments',
 'delivery.completed':'logistics'
};
const keys={orders:{int01:randomBytes(32)},
 payments:{int01:randomBytes(32)},logistics:{int01:randomBytes(32)}};
type OriginalM10={
 signAnalyticsEvent:(raw:Buffer,issuer:Issuer,kid:string,keyring:typeof keys)=>string,
 verifySignedEvent:(raw:Buffer,issuer:Issuer,kid:string,sig:string,
  keyring:typeof keys)=>{event:EventFact,hash:string}
};
let original:OriginalM10;
async function getM10(){
 if(!original)original=await import(pathToFileURL(upstream).href) as OriginalM10;
 return original;
}
function fact(kind:EventKind,merchantId=id(),orderId=id(),
 amountCents=kind==='order.canceled'||kind==='delivery.completed'?0:49900,
 refundId:string|null=kind==='refund.confirmed'?id():null):EventFact{
 return {eventId:id(),kind,merchantId,orderId,refundId,
  amountCents,occurredAt:at()};
}
async function proof(event:EventFact){
 const m10=await getM10();
 const raw=Buffer.from(JSON.stringify(event));
 const issuer=domainIssuer[event.kind];
 const signature=m10.signAnalyticsEvent(raw,issuer,'int01',keys);
 const input:SignedEnvelope={issuer,kid:'int01',signature,raw};
 const verify:TrustedVerifier=payload=>m10.verifySignedEvent(
  payload.raw,payload.issuer,payload.kid,payload.signature,keys);
 return {input,verify};
}
const worker=(consumer:Target)=>({
 authenticated:true,canConsumeEvents:true,consumer
});
const rejects=(p:Promise<unknown>,code:string)=>assert.rejects(p,
 e=>e instanceof IntegrationError&&e.code===code);
test('M11 LAB2 source-verified analytics-compatible signed event is fanout once',
 {skip:!runTests,timeout:120000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:18});
 try{
  const event=fact('order.completed');
  const signed=await proof(event);
  const accepted=await acceptVerifiedEvent(pool,signed.verify,signed.input);
  assert.equal(accepted.queued,2);
  assert.equal(accepted.duplicate,false);
  const duplicated=await acceptVerifiedEvent(pool,signed.verify,signed.input);
  assert.equal(duplicated.duplicate,true);
  assert.equal(duplicated.queued,0);
  const analytics=await claimJobs(pool,worker('analytics'),'analytics',10);
  const own=analytics.filter(x=>x.eventId===event.eventId);
  assert.equal(own.length,1);
  assert.equal(own[0]?.kind,'order.completed');
  assert.equal(own[0]?.amountCents,'49900');
  assert.equal(own[0]?.consumer,'analytics');
  await rejects(settleJob(pool,worker('finance'),'analytics',event.eventId,
   own[0]!.leaseToken,'applied'),'M11_CONSUMER_FORBIDDEN');
  await rejects(settleJob(pool,worker('analytics'),'analytics',event.eventId,
   id(),'applied'),'M11_LEASE_INVALID');
  const settled=await settleJob(pool,worker('analytics'),'analytics',
   event.eventId,own[0]!.leaseToken,'applied');
  assert.equal(settled.status,'applied');
  await rejects(settleJob(pool,worker('analytics'),'analytics',
   event.eventId,own[0]!.leaseToken,'applied'),'M11_LEASE_INVALID');
  const notification=await claimJobs(pool,worker('notifications'),
   'notifications',20);
  const n=notification.find(x=>x.eventId===event.eventId);
  assert.ok(n);
  await settleJob(pool,worker('notifications'),'notifications',
   event.eventId,n.leaseToken,'applied');
  const row=await pool.query<{count:number}>(
   'SELECT count(*)::int AS count FROM tala_integration_v2.inbox_events '+
   'WHERE event_id=$1::uuid',[event.eventId]);
  assert.equal(row.rows[0]?.count,1);
  await assert.rejects(pool.query('UPDATE tala_integration_v2.inbox_events '+
   "SET kind='order.canceled' WHERE event_id=$1::uuid",[event.eventId]),
   /M11_IMMUTABLE_EVENT/);
  const stats=await readDeliveryStats(pool,{authenticated:true,
   canMonitorIntegration:true});
  assert.ok(stats.some(x=>x.consumer==='analytics'&&x.status==='applied'));
  await rejects(readDeliveryStats(pool,{authenticated:false,
   canMonitorIntegration:true}),'M11_MONITOR_FORBIDDEN');
 }finally{await pool.end();}
});
test('M11 LAB2 per-consumer retry with backoff, dead letters and no cross-target coupling',
 {skip:!runTests,timeout:120000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 try{
  const m=id(),o=id(),signed=await proof(fact('payment.confirmed',m,o));
  const accepted=await acceptVerifiedEvent(pool,signed.verify,signed.input);
  assert.equal(accepted.queued,3);
  const finance=(await claimJobs(pool,worker('finance'),'finance',20))
   .find(x=>x.eventId===accepted.eventId);
  assert.ok(finance);
  let result=await settleJob(pool,worker('finance'),'finance',
   finance.eventId,finance.leaseToken,'retry','CONSUMER_UNAVAILABLE');
  assert.equal(result.status,'pending');
  const q=await pool.query<{attempts:number,code:string}>(
   'SELECT attempts,failure_code AS code FROM tala_integration_v2.dispatch_jobs '+
   "WHERE event_id=$1::uuid AND consumer='finance'",[finance.eventId]);
  assert.equal(q.rows[0]?.attempts,1);
  assert.equal(q.rows[0]?.code,'CONSUMER_UNAVAILABLE');
  const noEarlyRetry=await claimJobs(pool,worker('finance'),'finance',20);
  assert.equal(noEarlyRetry.some(x=>x.eventId===finance.eventId),false);
  await pool.query("UPDATE tala_integration_v2.dispatch_jobs "+
   "SET available_at=clock_timestamp()-interval '1 second' "+
   "WHERE event_id=$1::uuid AND consumer='finance'",[finance.eventId]);
  const retried=(await claimJobs(pool,worker('finance'),'finance',20))
   .find(x=>x.eventId===finance.eventId);
  assert.ok(retried);
  assert.equal(retried.attempt,2);
  result=await settleJob(pool,worker('finance'),'finance',
   finance.eventId,retried.leaseToken,'dead','PERMANENT_REJECTION');
  assert.equal(result.status,'dead');
  const noDeadRetry=await claimJobs(pool,worker('finance'),'finance',20);
  assert.equal(noDeadRetry.some(x=>x.eventId===finance.eventId),false);
  const analytics=(await claimJobs(pool,worker('analytics'),'analytics',20))
   .find(x=>x.eventId===finance.eventId);
  assert.ok(analytics,'a failed finance target cannot suppress analytics');
  await settleJob(pool,worker('analytics'),'analytics',finance.eventId,
   analytics.leaseToken,'applied');
  await rejects(settleJob(pool,worker('notifications'),'notifications',
   finance.eventId,id(),'retry','sensitive database error'),
   'M11_FAILURE_CODE_INVALID');
 }finally{await pool.end();}
});
test('M11 LAB2 concurrent signed redelivery cannot duplicate jobs or cross merchants',
 {skip:!runTests,timeout:120000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:25});
 try{
  const m=id(),o=id(),event=fact('delivery.completed',m,o);
  const signed=await proof(event);
  const requests=await Promise.all(Array.from({length:20},()=>
   acceptVerifiedEvent(pool,signed.verify,signed.input)));
  assert.equal(requests.filter(x=>x.duplicate===false).length,1);
  assert.equal(requests.filter(x=>x.duplicate===true).length,19);
  const jobs=await pool.query<{count:number}>(
   'SELECT count(*)::int AS count FROM tala_integration_v2.dispatch_jobs '+
   'WHERE event_id=$1::uuid',[event.eventId]);
  assert.equal(jobs.rows[0]?.count,3);
  const forged=await proof({...event,amountCents:1});
  await assert.rejects(acceptVerifiedEvent(pool,forged.verify,forged.input));
  const other=await proof(fact('payment.confirmed',id(),o));
  await rejects(acceptVerifiedEvent(pool,other.verify,other.input),
   'M11_ORDER_MERCHANT_CONFLICT');
  const cancel=await proof(fact('order.canceled',m,o));
  await rejects(acceptVerifiedEvent(pool,cancel.verify,cancel.input),
   'M11_TERMINAL_CONFLICT');
 }finally{await pool.end();}
});
test('M11 LAB2 rejects forged issuer signatures, PII and duplicate business facts',
 {skip:!runTests,timeout:120000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:10});
 try{
  const m=id(),o=id(),first=fact('order.completed',m,o);
  const signed=await proof(first);
  await acceptVerifiedEvent(pool,signed.verify,signed.input);
  const second=await proof(fact('order.completed',m,o));
  await rejects(acceptVerifiedEvent(pool,second.verify,second.input),
   'M11_BUSINESS_DUPLICATE');
  const modified=Buffer.from(signed.input.raw.toString('utf8')
   .replace('49900','90000'));
  await assert.rejects(acceptVerifiedEvent(pool,signed.verify,{
   ...signed.input,raw:modified}));
  const injection=Buffer.from(JSON.stringify({
   ...first,eventId:id(),customerEmail:'secret@example.com'}));
  const m10=await getM10();
  await assert.rejects(acceptVerifiedEvent(pool,signed.verify,{
   issuer:'orders',kid:'int01',raw:injection,
   signature:m10.signAnalyticsEvent(injection,'orders','int01',keys)}));
  await rejects(claimJobs(pool,{authenticated:true,
   canConsumeEvents:false,consumer:'finance'},'finance'),
   'M11_CONSUMER_FORBIDDEN');
  await rejects(claimJobs(pool,worker('finance'),'finance',0),
   'M11_LIMIT_INVALID');
 }finally{await pool.end();}
});
