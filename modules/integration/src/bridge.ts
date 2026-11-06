/** M11 durable inbox and per-consumer at-least-once deliveries.
 * Source outbox atomicity is NOT provided by M11; each producer must
 * persist its outbox in its own transaction before integration LIVE.
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {IntegrationError,validateEnvelope,routing,validUuid,
 type IntegrationEvent,type Consumer,type Producer} from './events.js';

const DATABASES=['tala_integration_v2_test','tala_integration_v2_lab'];
const MAX_ATTEMPTS=3;
export type Publisher={trustedHost:true,source:Producer};
export type Claim=Readonly<{
 event:IntegrationEvent,consumer:Consumer,claimId:string,attempt:number
}>;
async function inTransaction<T>(pool:Pool,fn:(c:PoolClient)=>Promise<T>,readonly=false):Promise<T>{
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 const c=await pool.connect();
 try{
  await c.query(readonly?'BEGIN READ ONLY':'BEGIN');
  await c.query("SET LOCAL statement_timeout='12000ms'");
  await c.query("SET LOCAL lock_timeout='3000ms'");
  const d=await c.query<{database:string}>('SELECT current_database() AS database');
  if(!DATABASES.includes(d.rows[0]?.database??''))
   throw new IntegrationError('M11_LAB_ONLY');
  const value=await fn(c);
  await c.query('COMMIT');return value;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;
 }finally{c.release();}
}
const hash=(value:IntegrationEvent)=>createHash('sha256')
 .update(JSON.stringify(value)).digest('hex');
export async function publishEvent(pool:Pool,publisher:Publisher,raw:unknown){
 if(publisher?.trustedHost!==true)
  throw new IntegrationError('M11_PUBLISHER_UNTRUSTED');
 const event=validateEnvelope(raw);
 if(publisher.source!==event.source)
  throw new IntegrationError('M11_SOURCE_MISMATCH');
 return inTransaction(pool,async c=>{
  const fingerprint=hash(event);
  const created=await c.query(
   'INSERT INTO tala_integration_v2.events '+
   '(event_id,source,kind,order_id,merchant_id,occurred_at,payload_hash) '+
   'VALUES($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::timestamptz,$7) '+
   'ON CONFLICT(event_id) DO NOTHING RETURNING event_id',
   [event.eventId,event.source,event.kind,event.orderId,event.merchantId,
    event.occurredAt,fingerprint]);
  if(created.rowCount===0){
   const existing=await c.query<{payload_hash:string,source:string}>(
    'SELECT payload_hash,source FROM tala_integration_v2.events '+
    'WHERE event_id=$1::uuid',[event.eventId]);
   if(existing.rows[0]?.payload_hash!==fingerprint||
     existing.rows[0]?.source!==event.source)
    throw new IntegrationError('M11_EVENT_CONFLICT');
   return Object.freeze({eventId:event.eventId,duplicate:true as const,
    consumers:0});
  }
  for(const consumer of routing(event.kind)){
   await c.query('INSERT INTO tala_integration_v2.deliveries '+
    '(event_id,consumer) VALUES($1::uuid,$2)',[event.eventId,consumer]);
  }
  return Object.freeze({eventId:event.eventId,duplicate:false as const,
   consumers:routing(event.kind).length});
 });
}
export async function claimDelivery(pool:Pool,consumer:Consumer,
 eventId?:string):Promise<Claim|null>{
 if(!['notifications','logistics','analytics'].includes(consumer))
  throw new IntegrationError('M11_CONSUMER_INVALID');
 const onlyEvent=eventId===undefined?null:validUuid(eventId);
 return inTransaction(pool,async c=>{
  const row=await c.query<{
   event_id:string,consumer:Consumer,attempts:number,source:Producer,
   kind:IntegrationEvent['kind'],order_id:string,merchant_id:string,
   occurred_at:string
  }>(
   'SELECT d.event_id,d.consumer,d.attempts,e.source,e.kind,'+
   'e.order_id,e.merchant_id,'+
   "to_char(e.occurred_at AT TIME ZONE 'UTC',"+
   "'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS occurred_at "+
   'FROM tala_integration_v2.deliveries d '+
   'JOIN tala_integration_v2.events e ON e.event_id=d.event_id '+
   'WHERE d.consumer=$1 AND d.attempts<$2 '+
   'AND ($3::uuid IS NULL OR d.event_id=$3::uuid) AND ('+
   "(d.state='pending' AND d.next_attempt_at<=clock_timestamp()) OR "+
   "(d.state='leased' AND d.lease_until<=clock_timestamp())) "+
   'ORDER BY e.created_at,d.event_id LIMIT 1 FOR UPDATE OF d SKIP LOCKED',
   [consumer,MAX_ATTEMPTS,onlyEvent]);
  if(!row.rows[0])return null;
  const picked=row.rows[0],claimId=randomUUID();
  await c.query('UPDATE tala_integration_v2.deliveries SET '+
   "state='leased',claim_id=$3::uuid,"+
   "lease_until=clock_timestamp()+interval '30 seconds',"+
   'attempts=attempts+1,updated_at=clock_timestamp() '+
   'WHERE event_id=$1::uuid AND consumer=$2',
   [picked.event_id,consumer,claimId]);
  return Object.freeze({
   event:validateEnvelope({schemaVersion:1,eventId:picked.event_id,
    source:picked.source,kind:picked.kind,
    orderId:picked.order_id,merchantId:picked.merchant_id,
    occurredAt:picked.occurred_at}),
   consumer,claimId,attempt:picked.attempts+1
  });
 });
}
async function settle(pool:Pool,claim:Claim,success:boolean){
 const eventId=validUuid(claim.event.eventId),lease=validUuid(claim.claimId);
 if(!['notifications','logistics','analytics'].includes(claim.consumer))
  throw new IntegrationError('M11_CONSUMER_INVALID');
 return inTransaction(pool,async c=>{
  const r=await c.query<{state:string}>(
   'UPDATE tala_integration_v2.deliveries SET '+
   (success?"state='delivered',":"state=CASE WHEN attempts>=3 THEN 'dead' ELSE 'pending' END,")+
   'claim_id=NULL,lease_until=NULL,'+
   (success?'':"next_attempt_at=clock_timestamp()+interval '2 seconds' * attempts,")+
   'updated_at=clock_timestamp() '+
   'WHERE event_id=$1::uuid AND consumer=$2 AND claim_id=$3::uuid '+
   "AND state='leased' AND lease_until>clock_timestamp() "+
   'RETURNING state',[eventId,claim.consumer,lease]);
  if(!r.rows[0])throw new IntegrationError('M11_STALE_LEASE');
  return Object.freeze({eventId,consumer:claim.consumer,
   state:r.rows[0].state,success});
 });
}
export const acknowledgeDelivery=(pool:Pool,claim:Claim)=>settle(pool,claim,true);
export const rejectDelivery=(pool:Pool,claim:Claim)=>settle(pool,claim,false);

export async function deliverOnce(pool:Pool,consumer:Consumer,
 adapter:{handle:(event:IntegrationEvent,deliveryId:string)=>Promise<void>},
 eventId?:string){
 const claim=await claimDelivery(pool,consumer,eventId);
 if(!claim)return Object.freeze({processed:false as const});
 try{
  // Idempotent consumer must use eventId + consumer as its delivery key.
  await adapter.handle(claim.event,claim.event.eventId+'|'+consumer);
  const applied=await acknowledgeDelivery(pool,claim);
  return Object.freeze({processed:true as const,delivered:true as const,
   eventId:claim.event.eventId,state:applied.state});
 }catch{
  // Never persist exception text/stack (it can contain PII or credentials).
  const result=await rejectDelivery(pool,claim);
  return Object.freeze({processed:true as const,delivered:false as const,
   eventId:claim.event.eventId,state:result.state});
 }
}
export async function readBridgeMetrics(pool:Pool,
 trusted:{canMonitorIntegration?:boolean}){
 if(trusted?.canMonitorIntegration!==true)
  throw new IntegrationError('M11_FORBIDDEN');
 return inTransaction(pool,async c=>{
  const counts=await c.query<{consumer:string,state:string,count:number}>(
   'SELECT consumer,state,count(*)::int AS count '+
   'FROM tala_integration_v2.deliveries '+
   'GROUP BY consumer,state ORDER BY consumer,state');
  return Object.freeze({model:'m11_inbox_v1' as const,commercialReady:false as const,
   counts:Object.freeze(counts.rows.map(x=>Object.freeze(x)))});
 },true);
}
