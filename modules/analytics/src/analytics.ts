/** M10 analytical read model. No reads from other modules' databases.
 * Trusted issuer events are input; source-of-truth remains in M1/M2/M8/M3.
 */
import type {Pool,PoolClient} from 'pg';
import {AnalyticsError,verifySignedEvent,
 type Issuer,type IssuerKeys,type AnalyticsEvent} from './contract.js';

export type AnalyticsConfig={pool:Pool,keys:IssuerKeys};
export type AnalyticsActor={
 actorId:string,authenticated:boolean,
 merchantId?:string,canReadMerchantAnalytics?:boolean,
 canReadPlatformAnalytics?:boolean
};
const LAB_DBS=['tala_analytics_v2_test','tala_analytics_v2_lab'];
type Counters={
 ordersCompleted:string,ordersCanceled:string,deliveriesCompleted:string,
 paymentsConfirmed:string,refundsConfirmed:string,orderGmvCents:string,
 paymentsCents:string,refundsCents:string
};
function dbStr(v:unknown):string{
 if(typeof v!=='string'&&typeof v!=='number')
  throw new AnalyticsError('M10_DB_VALUE_INVALID');
 const n=String(v);
 if(!/^-?\d+$/.test(n))throw new AnalyticsError('M10_DB_VALUE_INVALID');
 return n;
}
async function transaction<T>(pool:Pool,readOnly:boolean,
 fn:(client:PoolClient)=>Promise<T>){
 const client=await pool.connect();
 try{
  await client.query(readOnly?'BEGIN READ ONLY':'BEGIN');
  await client.query("SET LOCAL statement_timeout='12000ms'");
  await client.query("SET LOCAL lock_timeout='3000ms'");
  const db=await client.query<{dbname:string}>('SELECT current_database() AS dbname');
  if(!LAB_DBS.includes(db.rows[0]?.dbname??''))
   throw new AnalyticsError('M10_LAB_ONLY');
  const value=await fn(client);
  await client.query('COMMIT');
  return value;
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;
 }finally{client.release();}
}
async function orderLock(c:PoolClient,orderId:string){
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,2026))',
  [orderId]);
}
async function checkBusinessFact(c:PoolClient,event:AnalyticsEvent){
 const {kind,orderId,merchantId,refundId,amountCents}=event;
 const outcome=await c.query<{kind:string,merchant_id:string}>(
  'SELECT kind,merchant_id FROM tala_analytics_v2.order_outcomes '+
  'WHERE order_id=$1::uuid',[orderId]);
 if(outcome.rows[0]&&outcome.rows[0].merchant_id!==merchantId)
  throw new AnalyticsError('M10_MERCHANT_ORDER_CONFLICT');
 if(kind==='order.completed'||kind==='order.canceled'){
  if(outcome.rows[0])
   throw new AnalyticsError('M10_BUSINESS_EVENT_CONFLICT');
  if(kind==='order.canceled'){
   const delivery=await c.query('SELECT 1 FROM tala_analytics_v2.delivery_facts '+
    'WHERE order_id=$1::uuid',[orderId]);
   if(delivery.rowCount)throw new AnalyticsError('M10_TERMINAL_CONFLICT');
  }
  return;
 }
 if(kind==='delivery.completed'){
  if(outcome.rows[0]?.kind==='order.canceled')
   throw new AnalyticsError('M10_TERMINAL_CONFLICT');
  const previous=await c.query('SELECT 1 FROM tala_analytics_v2.delivery_facts '+
   'WHERE order_id=$1::uuid',[orderId]);
  if(previous.rowCount)throw new AnalyticsError('M10_BUSINESS_EVENT_CONFLICT');
  return;
 }
 const payment=await c.query<{merchant_id:string,amount_cents:string}>(
  'SELECT merchant_id,amount_cents::text FROM tala_analytics_v2.payment_facts '+
  'WHERE order_id=$1::uuid',[orderId]);
 if(kind==='payment.confirmed'){
  if(payment.rowCount)throw new AnalyticsError('M10_BUSINESS_EVENT_CONFLICT');
  return;
 }
 // Refunds are analytics of confirmed PSP refunds, not requested refunds.
 if(!payment.rows[0])
  throw new AnalyticsError('M10_MISSING_PAYMENT_FACT');
 if(payment.rows[0].merchant_id!==merchantId)
  throw new AnalyticsError('M10_MERCHANT_ORDER_CONFLICT');
 const prior=await c.query('SELECT 1 FROM tala_analytics_v2.refund_facts '+
  'WHERE refund_id=$1::uuid',[refundId]);
 if(prior.rowCount)throw new AnalyticsError('M10_BUSINESS_EVENT_CONFLICT');
 const other=await c.query<{amount:string}>(
  'SELECT COALESCE(SUM(amount_cents),0)::text AS amount '+
  'FROM tala_analytics_v2.refund_facts WHERE order_id=$1::uuid',[orderId]);
 if(BigInt(other.rows[0]!.amount)+BigInt(amountCents)>
    BigInt(payment.rows[0].amount_cents))
  throw new AnalyticsError('M10_REFUND_EXCEEDS_CAPTURE');
}
function increments(kind:AnalyticsEvent['kind'],value:number){
 return {
  ordersCompleted:kind==='order.completed'?1:0,
  ordersCanceled:kind==='order.canceled'?1:0,
  deliveriesCompleted:kind==='delivery.completed'?1:0,
  paymentsConfirmed:kind==='payment.confirmed'?1:0,
  refundsConfirmed:kind==='refund.confirmed'?1:0,
  orderGmvCents:kind==='order.completed'?value:0,
  paymentsCents:kind==='payment.confirmed'?value:0,
  refundsCents:kind==='refund.confirmed'?value:0
 };
}
async function addMetrics(c:PoolClient,event:AnalyticsEvent){
 const m=increments(event.kind,event.amountCents);
 const table='tala_analytics_v2.daily_merchant_metrics';
 const fields=['orders_completed','orders_canceled','deliveries_completed',
  'payments_confirmed','refunds_confirmed','order_gmv_cents','payments_cents',
  'refunds_cents'];
 const refs=fields.map((field,i)=>field+'='+table+'.'+field+
  '+EXCLUDED.'+field).join(',');
 const sql='INSERT INTO '+table+' '+
  '(merchant_id,event_day,'+fields.join(',')+') '+
  'VALUES($1::uuid,$2::date,$3,$4,$5,$6,$7,$8,$9,$10) '+
  'ON CONFLICT(merchant_id,event_day) DO UPDATE SET '+refs+
  ',updated_at=clock_timestamp()';
 await c.query(sql,[event.merchantId,event.occurredAt.slice(0,10),
  m.ordersCompleted,m.ordersCanceled,m.deliveriesCompleted,
  m.paymentsConfirmed,m.refundsConfirmed,m.orderGmvCents,
  m.paymentsCents,m.refundsCents]);
}
async function insertFact(c:PoolClient,event:AnalyticsEvent){
 const args=[event.orderId,event.merchantId,event.amountCents,event.eventId];
 switch(event.kind){
  case 'order.completed':
  case 'order.canceled':
   await c.query('INSERT INTO tala_analytics_v2.order_outcomes '+
    '(order_id,merchant_id,amount_cents,event_id,kind) '+
    'VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5)',
    [...args,event.kind]);break;
  case 'payment.confirmed':
   await c.query('INSERT INTO tala_analytics_v2.payment_facts '+
    '(order_id,merchant_id,amount_cents,event_id) '+
    'VALUES($1::uuid,$2::uuid,$3,$4::uuid)',args);break;
  case 'refund.confirmed':
   await c.query('INSERT INTO tala_analytics_v2.refund_facts '+
    '(order_id,merchant_id,amount_cents,event_id,refund_id) '+
    'VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid)',
    [...args,event.refundId]);break;
  case 'delivery.completed':
   await c.query('INSERT INTO tala_analytics_v2.delivery_facts '+
    '(order_id,merchant_id,event_id) VALUES($1::uuid,$2::uuid,$3::uuid)',
    [event.orderId,event.merchantId,event.eventId]);break;
 }
}
export async function ingestAnalyticsEvent(config:AnalyticsConfig,input:{
 issuer:Issuer,kid:string,signature:string,raw:Buffer
}){
 const verified=verifySignedEvent(input.raw,input.issuer,input.kid,
  input.signature,config.keys);
 const event=verified.event;
 return transaction(config.pool,false,async c=>{
  await orderLock(c,event.orderId);
  const same=await c.query<{payload_hash:string,issuer:string}>(
   'SELECT payload_hash,issuer FROM tala_analytics_v2.ingested_events '+
   'WHERE event_id=$1::uuid',[event.eventId]);
  if(same.rows[0]){
   if(same.rows[0].payload_hash!==verified.hash||
      same.rows[0].issuer!==input.issuer)
    throw new AnalyticsError('M10_EVENT_ID_CONFLICT');
   return Object.freeze({eventId:event.eventId,duplicate:true as const,
    applied:false as const});
  }
  await checkBusinessFact(c,event);
  await c.query('INSERT INTO tala_analytics_v2.ingested_events '+
   '(event_id,issuer,kind,merchant_id,order_id,refund_id,amount_cents,'+
   'occurred_at,event_day,payload_hash) '+
   'VALUES($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7,$8::timestamptz,$9::date,$10)',
   [event.eventId,input.issuer,event.kind,event.merchantId,event.orderId,
    event.refundId,event.amountCents,event.occurredAt,event.occurredAt.slice(0,10),
    verified.hash]);
  await insertFact(c,event);
  await addMetrics(c,event);
  return Object.freeze({eventId:event.eventId,duplicate:false as const,
   applied:true as const});
 });
}
function interval(from:string,to:string){
 const date=/^\d{4}-\d{2}-\d{2}$/;
 if(!date.test(from)||!date.test(to)||
  new Date(from+'T00:00:00.000Z').toISOString().slice(0,10)!==from||
  new Date(to+'T00:00:00.000Z').toISOString().slice(0,10)!==to){
  throw new AnalyticsError('M10_REPORT_RANGE_INVALID');
 }
 const days=(Date.parse(to+'T00:00:00Z')-
  Date.parse(from+'T00:00:00Z'))/86_400_000;
 if(days<0||days>30)throw new AnalyticsError('M10_REPORT_RANGE_INVALID');
 return {from,to};
}
type RawMetric={event_day:string,orders_completed:string,
 orders_canceled:string,deliveries_completed:string,
 payments_confirmed:string,refunds_confirmed:string,
 order_gmv_cents:string,payments_cents:string,refunds_cents:string};
function mappedMetric(r:RawMetric){
 return Object.freeze({
  date:r.event_day.slice(0,10),ordersCompleted:dbStr(r.orders_completed),
  ordersCanceled:dbStr(r.orders_canceled),
  deliveriesCompleted:dbStr(r.deliveries_completed),
  paymentsConfirmed:dbStr(r.payments_confirmed),
  refundsConfirmed:dbStr(r.refunds_confirmed),
  orderGmvCents:dbStr(r.order_gmv_cents),
  paymentsCents:dbStr(r.payments_cents),
  refundsCents:dbStr(r.refunds_cents),
  netPaymentFlowCents:(BigInt(dbStr(r.payments_cents))-
    BigInt(dbStr(r.refunds_cents))).toString()
 });
}
const FIELDS=['orders_completed','orders_canceled','deliveries_completed',
 'payments_confirmed','refunds_confirmed','order_gmv_cents','payments_cents',
 'refunds_cents'];
function sumColumns(){
 return FIELDS.map(x=>'COALESCE(SUM('+x+'),0)::text AS '+x).join(',');
}
export async function merchantAnalytics(pool:Pool,actor:AnalyticsActor,
 merchantId:string,from:string,to:string){
 const requested=uuidAnalytics(merchantId);
 interval(from,to);
 if(actor?.authenticated!==true||
  actor.canReadMerchantAnalytics!==true||
  uuidAnalytics(actor.merchantId)!==requested)
  throw new AnalyticsError('M10_FORBIDDEN');
 return transaction(pool,true,async c=>{
  const q=await c.query<RawMetric>(
   'SELECT event_day::text,'+FIELDS.map(x=>x+'::text').join(',')+
   ' FROM tala_analytics_v2.daily_merchant_metrics '+
   'WHERE merchant_id=$1::uuid AND event_day BETWEEN $2::date AND $3::date '+
   'ORDER BY event_day',[requested,from,to]);
  const total=await c.query<RawMetric>(
   'SELECT '+sumColumns()+' FROM tala_analytics_v2.daily_merchant_metrics '+
   'WHERE merchant_id=$1::uuid AND event_day BETWEEN $2::date AND $3::date',
   [requested,from,to]);
  return Object.freeze({scope:'merchant' as const,merchantId:requested,
   from,to,derivedNotLedger:true as const,days:Object.freeze(q.rows.map(mappedMetric)),
   totals:mappedMetric({...total.rows[0]!,event_day:from})});
 });
}
function uuidAnalytics(s:unknown){
 if(typeof s!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s))
  throw new AnalyticsError('M10_FORBIDDEN');
 return s.toLowerCase();
}
export async function platformAnalytics(pool:Pool,actor:AnalyticsActor,
 from:string,to:string){
 interval(from,to);
 if(actor?.authenticated!==true||actor.canReadPlatformAnalytics!==true)
  throw new AnalyticsError('M10_FORBIDDEN');
 return transaction(pool,true,async c=>{
  const q=await c.query<RawMetric>(
   'SELECT event_day::text,'+sumColumns()+
   ' FROM tala_analytics_v2.daily_merchant_metrics '+
   'WHERE event_day BETWEEN $1::date AND $2::date '+
   'GROUP BY event_day ORDER BY event_day',[from,to]);
  const t=await c.query<RawMetric>(
   'SELECT '+sumColumns()+' FROM tala_analytics_v2.daily_merchant_metrics '+
   'WHERE event_day BETWEEN $1::date AND $2::date',[from,to]);
  return Object.freeze({scope:'platform' as const,from,to,
   derivedNotLedger:true as const,days:Object.freeze(q.rows.map(mappedMetric)),
   totals:mappedMetric({...t.rows[0]!,event_day:from})});
 });
}
