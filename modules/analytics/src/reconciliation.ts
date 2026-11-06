/** M10 derived-read-model integrity repair, entirely inside own schema.
 * This is not financial settlement or a replay of missing producer events.
 */
import type {Pool,PoolClient} from 'pg';
import {AnalyticsError,uuid} from './contract.js';

export type AnalyticsMaintenanceActor={
 authenticated:boolean,canAuditAnalytics?:boolean,
 canRepairAnalytics?:boolean
};
const FIELDS=['orders_completed','orders_canceled','deliveries_completed',
 'payments_confirmed','refunds_confirmed','order_gmv_cents','payments_cents',
 'refunds_cents'] as const;
type Values=Record<typeof FIELDS[number],string>;
function date(input:string){
 if(typeof input!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input))
  throw new AnalyticsError('M10_REPORT_RANGE_INVALID');
 const ms=Date.parse(input+'T00:00:00Z');
 if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==input)
  throw new AnalyticsError('M10_REPORT_RANGE_INVALID');
 return input;
}
async function withClient<T>(pool:Pool,readOnly:boolean,
 fn:(c:PoolClient)=>Promise<T>):Promise<T>{
 const c=await pool.connect();
 try{
  await c.query(readOnly?'BEGIN READ ONLY':'BEGIN');
  await c.query("SET LOCAL statement_timeout='12000ms'");
  await c.query("SET LOCAL lock_timeout='3000ms'");
  const db=await c.query<{database:string}>('SELECT current_database() AS database');
  if(!['tala_analytics_v2_test','tala_analytics_v2_lab'].includes(
   db.rows[0]?.database??''))throw new AnalyticsError('M10_LAB_ONLY');
  const answer=await fn(c);
  await c.query('COMMIT');return answer;
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;
 }finally{c.release();}
}
const zeros=():Values=>Object.fromEntries(FIELDS.map(x=>[x,'0'])) as Values;
function project(rows:Record<string,unknown>[]):Values{
 if(!rows[0])return zeros();
 return Object.fromEntries(FIELDS.map(x=>{
  const value=rows[0]![x];
  if(typeof value!=='string'||!/^[0-9]+$/.test(value))
   throw new AnalyticsError('M10_DB_VALUE_INVALID');
  return [x,value];
 })) as Values;
}
const expectedQuery=()=>{
 const counter=(kind:string)=>'count(*) FILTER (WHERE kind=\''+kind+'\')::text';
 const cents=(kind:string)=>'COALESCE(SUM(amount_cents) FILTER (WHERE kind=\''+
  kind+'\'),0)::text';
 return 'SELECT '+
  counter('order.completed')+' AS orders_completed,'+
  counter('order.canceled')+' AS orders_canceled,'+
  counter('delivery.completed')+' AS deliveries_completed,'+
  counter('payment.confirmed')+' AS payments_confirmed,'+
  counter('refund.confirmed')+' AS refunds_confirmed,'+
  cents('order.completed')+' AS order_gmv_cents,'+
  cents('payment.confirmed')+' AS payments_cents,'+
  cents('refund.confirmed')+' AS refunds_cents '+
  'FROM tala_analytics_v2.ingested_events '+
  'WHERE merchant_id=$1::uuid AND event_day=$2::date';
};
export async function reconcileMerchantDay(pool:Pool,
 actor:AnalyticsMaintenanceActor,merchantId:string,day:string,
 mode:'audit'|'repair'='audit'){
 if(actor?.authenticated!==true||actor.canAuditAnalytics!==true||
    (mode==='repair'&&actor.canRepairAnalytics!==true))
  throw new AnalyticsError('M10_FORBIDDEN');
 if(mode!=='audit'&&mode!=='repair')
  throw new AnalyticsError('M10_REQUEST_INVALID');
 const merchant=uuid(merchantId),d=date(day);
 return withClient(pool,mode==='audit',async c=>{
  // Same per-merchant/day advisory lock as ingestion. When the lock releases
  // there are no partial events or rollup updates to observe.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,3030))',
   [merchant+'|'+d]);
  const want=await c.query<Record<string,unknown>>(expectedQuery(),[merchant,d]);
  const stored=await c.query<Record<string,unknown>>(
   'SELECT '+FIELDS.map(x=>x+'::text').join(',')+
   ' FROM tala_analytics_v2.daily_merchant_metrics '+
   'WHERE merchant_id=$1::uuid AND event_day=$2::date',[merchant,d]);
  const expected=project(want.rows),actual=project(stored.rows);
  const mismatched=FIELDS.filter(k=>expected[k]!==actual[k]);
  if(mode==='repair'&&mismatched.length){
   const colNames=FIELDS.join(',');
   const updates=FIELDS.map(x=>x+'=EXCLUDED.'+x).join(',');
   await c.query('INSERT INTO tala_analytics_v2.daily_merchant_metrics '+
    '(merchant_id,event_day,'+colNames+') '+
    'VALUES($1::uuid,$2::date,'+
     FIELDS.map((_,i)=>'$'+(i+3)).join(',')+') '+
    'ON CONFLICT(merchant_id,event_day) DO UPDATE SET '+
    updates+',updated_at=clock_timestamp()',
    [merchant,d,...FIELDS.map(x=>expected[x])]);
  }
  return Object.freeze({scope:'merchant_day_integrity' as const,
   merchantId:merchant,date:d,driftDetected:mismatched.length>0,
   repaired:mode==='repair'&&mismatched.length>0,
   differingFields:Object.freeze(mismatched),
   expected:Object.freeze(expected),observed:Object.freeze(actual),
   derivedNotLedger:true as const});
 });
}
