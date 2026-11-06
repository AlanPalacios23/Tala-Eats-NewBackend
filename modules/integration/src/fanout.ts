/** M11 durable, internal-only event routing. No business consumer calls.
 * Verified event contract supplied by a trusted host (M10 verifier).
 * This module delivers jobs AT LEAST ONCE; consumers must be idempotent.
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {IntegrationError} from './manifest.js';

export const KINDS={
 'order.completed':'orders',
 'order.canceled':'orders',
 'payment.confirmed':'payments',
 'refund.confirmed':'payments',
 'delivery.completed':'logistics'
} as const;
export type EventKind=keyof typeof KINDS;
export type Issuer='orders'|'payments'|'logistics';
export type Target='finance'|'notifications'|'analytics';
export type EventFact={
 eventId:string,kind:EventKind,merchantId:string,orderId:string,
 refundId:string|null,amountCents:number,occurredAt:string
};
export type SignedEnvelope={
 issuer:Issuer,kid:string,signature:string,raw:Buffer
};
export type TrustedVerifier=(input:SignedEnvelope)=>{event:EventFact,hash:string};
export type IntegrationWorker={authenticated:boolean,
 consumer:Target,canConsumeEvents:boolean};
export type LeasedJob={
 eventId:string,consumer:Target,leaseToken:string,attempt:number,
 kind:EventKind,issuer:Issuer,merchantId:string,orderId:string,
 refundId:string|null,amountCents:string,occurredAt:string
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LAB=['tala_integration_v2_test','tala_integration_v2_lab'];
const TARGETS:Readonly<Record<EventKind,readonly Target[]>>={
 'order.completed':['notifications','analytics'],
 'order.canceled':['notifications','analytics'],
 'payment.confirmed':['finance','notifications','analytics'],
 'refund.confirmed':['finance','notifications','analytics'],
 'delivery.completed':['finance','notifications','analytics']
};
const CODES=new Set(['DEPENDENCY_NOT_READY','CONSUMER_UNAVAILABLE',
 'TRANSIENT_FAILURE','PERMANENT_REJECTION']);
function fail(code:string):never{throw new IntegrationError(code);}
function validate(value:unknown):EventFact{
 if(!value||typeof value!=='object'||Array.isArray(value))
  fail('M11_EVENT_INVALID');
 const v=value as Record<string,unknown>;
 const fields=['eventId','kind','merchantId','orderId','refundId',
  'amountCents','occurredAt'];
 if(Object.keys(v).length!==fields.length||
  Object.keys(v).some(x=>!fields.includes(x))||
  fields.some(x=>!Object.hasOwn(v,x))||
  typeof v.kind!=='string'||!Object.hasOwn(KINDS,v.kind))
  fail('M11_EVENT_INVALID');
 for(const key of ['eventId','merchantId','orderId']){
  if(typeof v[key]!=='string'||!UUID.test(v[key]))fail('M11_EVENT_INVALID');
 }
 if(v.refundId!==null&&(typeof v.refundId!=='string'||!UUID.test(v.refundId)))
  fail('M11_EVENT_INVALID');
 const kind=v.kind as EventKind;
 if((kind==='refund.confirmed')!==(v.refundId!==null)||
  !Number.isSafeInteger(v.amountCents)||
  typeof v.amountCents!=='number'||v.amountCents<0||
  v.amountCents>100_000_000||
  ((kind==='delivery.completed'||kind==='order.canceled')?
   v.amountCents!==0:v.amountCents===0))
  fail('M11_EVENT_INVALID');
 if(typeof v.occurredAt!=='string'||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v.occurredAt)||
  !Number.isFinite(Date.parse(v.occurredAt)))
  fail('M11_EVENT_INVALID');
 return v as EventFact;
}
async function inTransaction<T>(pool:Pool,readonly:boolean,
 run:(client:PoolClient)=>Promise<T>):Promise<T>{
 const c=await pool.connect();
 try{
  await c.query(readonly?'BEGIN READ ONLY':'BEGIN');
  await c.query("SET LOCAL statement_timeout='15000ms'");
  await c.query("SET LOCAL lock_timeout='4000ms'");
  const q=await c.query<{name:string}>('SELECT current_database() AS name');
  if(!LAB.includes(q.rows[0]?.name??''))
   throw new IntegrationError('M11_LAB_DATABASE_ONLY');
  const result=await run(c);await c.query('COMMIT');return result;
 }catch(err){await c.query('ROLLBACK').catch(()=>{});throw err;
 }finally{c.release();}
}
function authorize(worker:IntegrationWorker,target:Target){
 if(!worker||worker.authenticated!==true||
  worker.canConsumeEvents!==true||worker.consumer!==target)
  fail('M11_CONSUMER_FORBIDDEN');
}
export async function acceptVerifiedEvent(pool:Pool,
 verify:TrustedVerifier,input:SignedEnvelope){
 if(typeof verify!=='function'||!input||!Buffer.isBuffer(input.raw)||
  input.raw.length<2||input.raw.length>8192)
  fail('M11_SIGNATURE_REQUIRED');
 const result=verify(input);
 const event=validate(result?.event);
 if(typeof result.hash!=='string'||!/^[a-f0-9]{64}$/.test(result.hash)||
  createHash('sha256').update(input.raw).digest('hex')!==result.hash||
  !Object.hasOwn(KINDS,event.kind)||KINDS[event.kind]!==input.issuer)
  fail('M11_SIGNATURE_INVALID');
 if(event.eventId!==event.eventId.toLowerCase()||
   event.orderId!==event.orderId.toLowerCase()||
   event.merchantId!==event.merchantId.toLowerCase()||
   (event.refundId!==null&&event.refundId!==event.refundId.toLowerCase()))
  fail('M11_EVENT_INVALID');
 return inTransaction(pool,false,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,1101))',
   [event.eventId]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,1102))',
   [event.orderId]);
  const exists=await c.query<{payload_hash:string,issuer:Issuer}>(
   'SELECT payload_hash,issuer FROM tala_integration_v2.inbox_events '+
   'WHERE event_id=$1::uuid',[event.eventId]);
  if(exists.rows[0]){
   if(exists.rows[0].payload_hash!==result.hash||
      exists.rows[0].issuer!==input.issuer)
    fail('M11_EVENT_ID_CONFLICT');
   return Object.freeze({eventId:event.eventId,duplicate:true,
    queued:0});
  }
  const facts=await c.query<{kind:EventKind,merchant_id:string}>(
   'SELECT kind,merchant_id FROM tala_integration_v2.inbox_events '+
   'WHERE order_id=$1::uuid',[event.orderId]);
  if(facts.rows.some(f=>f.merchant_id!==event.merchantId))
   fail('M11_ORDER_MERCHANT_CONFLICT');
  if(facts.rows.some(f=>f.kind===event.kind&&event.kind!=='refund.confirmed'))
   fail('M11_BUSINESS_DUPLICATE');
  if(facts.rows.some(f=>
   (event.kind==='order.completed'&&f.kind==='order.canceled')||
   (event.kind==='order.canceled'&&f.kind==='order.completed')||
   (event.kind==='order.canceled'&&f.kind==='delivery.completed')||
   (event.kind==='delivery.completed'&&f.kind==='order.canceled')))
   fail('M11_TERMINAL_CONFLICT');
  if(event.refundId){
   const refund=await c.query('SELECT 1 FROM tala_integration_v2.inbox_events '+
    'WHERE refund_id=$1::uuid',[event.refundId]);
   if(refund.rowCount)fail('M11_BUSINESS_DUPLICATE');
  }
  await c.query('INSERT INTO tala_integration_v2.inbox_events '+
   '(event_id,issuer,kind,merchant_id,order_id,refund_id,amount_cents,'+
   'occurred_at,event_day,payload_hash) '+
   'VALUES($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8::timestamptz,'+
   '$9::date,$10)',
   [event.eventId,input.issuer,event.kind,event.merchantId,event.orderId,
    event.refundId,event.amountCents,event.occurredAt,
    event.occurredAt.slice(0,10),result.hash]);
  const recipients=TARGETS[event.kind];
  for(const consumer of recipients){
   await c.query('INSERT INTO tala_integration_v2.dispatch_jobs '+
    '(event_id,consumer) VALUES($1::uuid,$2)',[event.eventId,consumer]);
  }
  return Object.freeze({eventId:event.eventId,duplicate:false,
   queued:recipients.length});
 });
}
export async function claimJobs(pool:Pool,worker:IntegrationWorker,
 target:Target,limit=1):Promise<LeasedJob[]>{
 authorize(worker,target);
 if(!Number.isSafeInteger(limit)||limit<1||limit>20)
  fail('M11_LIMIT_INVALID');
 return inTransaction(pool,false,async c=>{
  // Dead-letter exhausted leases before acquiring more work. A previously
  // applied event can never be selected for reprocessing.
  await c.query(
   "UPDATE tala_integration_v2.dispatch_jobs SET status='dead',"+
   "lease_token=NULL,leased_until=NULL,failure_code='ATTEMPTS_EXHAUSTED'"+
   " WHERE consumer=$1 AND status='leased' AND "+
   "leased_until<clock_timestamp() AND attempts>=5",[target]);
  const q=await c.query<{event_id:string,consumer:Target}>(
   'SELECT event_id,consumer FROM tala_integration_v2.dispatch_jobs '+
   'WHERE consumer=$1 AND attempts<5 AND '+
   "((status='pending' AND available_at<=clock_timestamp()) OR "+
   "(status='leased' AND leased_until<clock_timestamp())) "+
   'ORDER BY available_at,event_id FOR UPDATE SKIP LOCKED LIMIT $2',
   [target,limit]);
  const jobs:LeasedJob[]=[];
  for(const row of q.rows){
   const token=randomUUID();
   const updated=await c.query<{
    attempts:number,kind:EventKind,issuer:Issuer,
    merchant_id:string,order_id:string,refund_id:string|null,
    amount_cents:string,occurred_at:string
   }>('UPDATE tala_integration_v2.dispatch_jobs d '+
    "SET status='leased',attempts=d.attempts+1,"+
    "lease_token=$3::uuid,leased_until=clock_timestamp()+interval '30 seconds',"+
    'failure_code=NULL '+
    'FROM tala_integration_v2.inbox_events e '+
    'WHERE d.event_id=$1::uuid AND d.consumer=$2 AND e.event_id=d.event_id '+
    'RETURNING d.attempts,e.kind,e.issuer,e.merchant_id::text,'+
    'e.order_id::text,e.refund_id::text,e.amount_cents::text,'+
    "to_char(e.occurred_at AT TIME ZONE 'UTC',"+
    "'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS occurred_at",
    [row.event_id,target,token]);
   const detail=updated.rows[0];
   if(!detail)fail('M11_JOB_MISSING');
   jobs.push(Object.freeze({
    eventId:row.event_id,consumer:target,leaseToken:token,
    attempt:detail.attempts,
    kind:detail.kind,issuer:detail.issuer,merchantId:detail.merchant_id,
    orderId:detail.order_id,refundId:detail.refund_id,
    amountCents:detail.amount_cents,occurredAt:detail.occurred_at
   }));
  }
  return jobs;
 });
}
export async function settleJob(pool:Pool,worker:IntegrationWorker,
 target:Target,eventId:string,leaseToken:string,
 outcome:'applied'|'retry'|'dead',
 failureCode?:string){
 authorize(worker,target);
 if(!UUID.test(eventId)||!UUID.test(leaseToken))
  fail('M11_JOB_INVALID');
 if(!['applied','retry','dead'].includes(outcome))
  fail('M11_JOB_INVALID');
 if(outcome!=='applied'&&(!failureCode||!CODES.has(failureCode)))
  fail('M11_FAILURE_CODE_INVALID');
 if(outcome==='applied'&&failureCode!==undefined)
  fail('M11_FAILURE_CODE_INVALID');
 return inTransaction(pool,false,async c=>{
  const q=await c.query<{status:string,attempts:number,token:string|null,
   expired:boolean}>(
   'SELECT status,attempts,lease_token::text AS token,'+
   'leased_until<=clock_timestamp() AS expired '+
   'FROM tala_integration_v2.dispatch_jobs '+
   'WHERE event_id=$1::uuid AND consumer=$2 FOR UPDATE',[eventId,target]);
  const row=q.rows[0];
  if(!row||row.status!=='leased'||row.token!==leaseToken||row.expired)
   fail('M11_LEASE_INVALID');
  const status=outcome==='applied'?'applied':
   outcome==='dead'||row.attempts>=5?'dead':'pending';
  const delay=outcome==='retry'?Math.min(300,2**row.attempts*5):0;
  await c.query('UPDATE tala_integration_v2.dispatch_jobs '+
   'SET status=$3,lease_token=NULL,leased_until=NULL,'+
   "available_at=clock_timestamp()+($4::int*interval '1 second'),"+
   'applied_at=CASE WHEN $3=\'applied\' THEN clock_timestamp() ELSE NULL END,'+
   'failure_code=$5 WHERE event_id=$1::uuid AND consumer=$2',
   [eventId,target,status,delay,status==='applied'?null:failureCode]);
  return Object.freeze({eventId,consumer:target,status,attempts:row.attempts});
 });
}
export async function readDeliveryStats(pool:Pool,actor:{
 authenticated:boolean,canMonitorIntegration:boolean
}){
 if(!actor||actor.authenticated!==true||actor.canMonitorIntegration!==true)
  fail('M11_MONITOR_FORBIDDEN');
 return inTransaction(pool,true,async c=>{
  const q=await c.query<{consumer:Target,status:string,count:string}>(
   'SELECT consumer,status,count(*)::text AS count '+
   'FROM tala_integration_v2.dispatch_jobs '+
   'GROUP BY consumer,status ORDER BY consumer,status');
  return Object.freeze(q.rows.map(row=>Object.freeze(row)));
 });
}
