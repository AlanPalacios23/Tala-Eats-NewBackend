/**
 * TALA Dispatch Engine v2 — INTERNAL failover only.
 * Only previously GEO-reserved orders whose assigned courier lost availability
 * are eligible. A future trusted Orders adapter MUST verify order existence,
 * authorization, status and version. No HTTP or production entry point.
 */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {LogisticsError} from './dispatch-service.ts';
import {validGeoPoint,type GeoPoint,TALA_GEO_VERSION} from './geo.ts';
import {rerouteFingerprint} from './command-integrity.ts';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyPattern=/^[a-zA-Z0-9_.:-]{16,128}$/;
const reject=(code:string):never=>{throw new LogisticsError(code);};
/** Must be supplied by a trusted Orders adapter and execute its
 * pre-pickup check on the SAME database connection/transaction.
 * A public caller or untrusted callback is NEVER permitted.
 * Module 2 intentionally does not import any Orders implementation. */
export type VerifyPrePickup=(
 client:PoolClient,
 context:Readonly<{orderId:string;restaurantId:string;
   courierId:string;zone:string}>
)=>Promise<boolean>;
/** Module boundary callback. A trusted Orders adapter must atomically
 * update its assignment and evidence on the SAME PoolClient. */
export type CommitOrdersReassignment=(
 client:PoolClient,
 context:Readonly<{orderId:string;restaurantId:string;previousCourierId:string;
   courierId:string;zone:string;logisticsVersion:string;commandKey:string}>
)=>Promise<boolean>;
export type RerouteResult=
 | Readonly<{decision:'REASSIGNED';orderId:string;previousCourierId:string;
    courierId:string;version:string;replayed:boolean}>
 | Readonly<{decision:'STILL_AVAILABLE'|'NO_AVAILABLE_COURIER';orderId:string;
    currentCourierId:string}>;

export async function reassignUnavailableDelivery(
 pool:Pool,orderId:string,expectedVersion:string,
 commandKey:string,restaurant:GeoPoint,maxDistanceMeters=20000,
 verifyPrePickup?:VerifyPrePickup,
 commitOrdersReassignment?:CommitOrdersReassignment
):Promise<RerouteResult>{
 if(typeof orderId!=='string'||!uuid.test(orderId)
   ||typeof expectedVersion!=='string'||!/^[1-9][0-9]{0,15}$/.test(expectedVersion)
   ||typeof commandKey!=='string'||!keyPattern.test(commandKey)
   ||!validGeoPoint(restaurant)||!Number.isFinite(maxDistanceMeters)
   ||maxDistanceMeters<=0||maxDistanceMeters>100000)
   reject('LOGISTICS_REROUTE_INPUT_INVALID');
 if(typeof verifyPrePickup!=='function')
   reject('LOGISTICS_ORDER_VERIFICATION_REQUIRED');
 if(typeof commitOrdersReassignment!=='function')
   reject('LOGISTICS_ORDER_SYNC_REQUIRED');
 orderId=orderId.toLowerCase();
 const digest=rerouteFingerprint(orderId,expectedVersion,restaurant,maxDistanceMeters);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='3000ms'");
  await client.query("SET LOCAL statement_timeout='10000ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,20261101))',[orderId]);
  const r=await client.query<{
   order_id:string;courier_id:string;restaurant_id:string;zone:string;
   status:string;version:string
  }>(
   "SELECT * FROM tala_logistics_v2.dispatch_reservations "+
   "WHERE order_id=$1::uuid FOR UPDATE",[orderId]
  );
  const row=r.rows[0];
  if(!row)throw new LogisticsError('LOGISTICS_DISPATCH_NOT_FOUND');
  const prior=await client.query<{
   event_type:string;details:{
    previousCourierId?:string;courierId?:string;version?:string;
    commandDigest?:string
   }
  }>(
   "SELECT event_type,details FROM tala_logistics_v2.dispatch_events "+
   "WHERE order_id=$1::uuid AND command_key=$2",[orderId,commandKey]
  );
  if(prior.rows[0]){
   const event=prior.rows[0];
   const evidence=event.details;
   if(event.event_type!=='dispatch.reassigned'
    ||typeof evidence?.previousCourierId!=='string'
    ||typeof evidence.courierId!=='string'
    ||typeof evidence.version!=='string')
    throw new LogisticsError('LOGISTICS_IDEMPOTENCY_CONFLICT');
   if(evidence.commandDigest!==digest)
    reject('LOGISTICS_IDEMPOTENCY_INPUT_CONFLICT');
   if(row.status!=='reserved'||row.courier_id!==evidence.courierId
     ||row.version!==evidence.version)
    reject('LOGISTICS_REROUTE_SUPERSEDED');
   await client.query('COMMIT');
   return {decision:'REASSIGNED',orderId,
    previousCourierId:evidence.previousCourierId,
    courierId:evidence.courierId,version:evidence.version,replayed:true};
  }
  if(row.status!=='reserved')reject('LOGISTICS_DISPATCH_FINALIZED');
  if(row.version!==expectedVersion)reject('LOGISTICS_VERSION_CONFLICT');
  // Legacy (non-GPS) reservations are never rerouted solely for lack of GPS.
  const origin=await client.query<{details:{dispatchMethod?:string}}>(
   "SELECT details FROM tala_logistics_v2.dispatch_events "+
   "WHERE order_id=$1::uuid AND event_type='dispatch.reserved' LIMIT 1",[orderId]
  );
  if(origin.rows[0]?.details.dispatchMethod!=='proximity')
   reject('LOGISTICS_REROUTE_REQUIRES_GEO_RESERVATION');

  // Mandatory fail-closed Orders verification. This check must lock/check
  // Orders state and pickup proof in the SAME transaction, before selecting
  // a replacement. No real Orders adapter is enabled in LAB2.
  const allowed=await verifyPrePickup!(client,{
   orderId,restaurantId:row.restaurant_id,courierId:row.courier_id,
   zone:row.zone
  });
  if(allowed!==true)reject('LOGISTICS_ORDER_NOT_VERIFIED_PRE_PICKUP');

  // Read under courier lock so a concurrent online/heartbeat update
  // cannot alter eligibility between inspection and commit.
  const current=await client.query<{
   approved:boolean;online:boolean;last_seen_at:Date|null;
   observed_at:Date|null
  }>(
   "SELECT c.approved,c.online,c.last_seen_at,p.observed_at "+
   "FROM tala_logistics_v2.couriers c "+
   "LEFT JOIN tala_logistics_v2.courier_positions p ON p.courier_id=c.id "+
   "WHERE c.id=$1::uuid FOR UPDATE OF c",[row.courier_id]
  );
  if(!current.rows[0])throw new LogisticsError('LOGISTICS_COURIER_NOT_FOUND');
  const old=current.rows[0];
  const server=await client.query<{now:Date}>("SELECT clock_timestamp() AS now");
  const now=server.rows[0]!.now.getTime();
  const fresh=(date:Date|null)=>date!==null&&date.getTime()<=now
   &&now-date.getTime()<=120000;
  if(old.approved&&old.online&&fresh(old.last_seen_at)&&fresh(old.observed_at)){
   await client.query('COMMIT');
   return {decision:'STILL_AVAILABLE',orderId,currentCourierId:row.courier_id};
  }
  // Haversine in PostgreSQL. Row lock on a candidate courier serializes
  // GPS writes (those acquire the same lock) and capacity reservations.
  const distance=
   "6371008.8*2*asin(sqrt(least(1.0,"+
   "power(sin(radians(p.latitude-$2::double precision)/2),2)+"+
   "cos(radians($2::double precision))*cos(radians(p.latitude))*"+
   "power(sin(radians(p.longitude-$3::double precision)/2),2))))";
  const sql=
   "SELECT c.id,c.capacity FROM tala_logistics_v2.couriers c "+
   "JOIN tala_logistics_v2.courier_positions p ON p.courier_id=c.id "+
   "WHERE c.approved AND c.online AND c.zone=$1 AND c.id<>$5::uuid "+
   "AND c.last_seen_at BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp() "+
   "AND p.observed_at BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp() "+
   "AND p.accuracy_m<=100 "+
   "AND (SELECT count(*) FROM tala_logistics_v2.dispatch_reservations d "+
   " WHERE d.courier_id=c.id AND d.status='reserved')<c.capacity "+
   "AND ("+distance+")<=$4::double precision "+
   "ORDER BY ("+distance+") ASC,c.id "+
   "FOR UPDATE OF c SKIP LOCKED LIMIT 1";
  const chosen=await client.query<{id:string;capacity:number}>(sql,[
   row.zone,restaurant.latitude,restaurant.longitude,maxDistanceMeters,row.courier_id
  ]);
  const candidate=chosen.rows[0];
  if(!candidate){
   await client.query('COMMIT');
   return {decision:'NO_AVAILABLE_COURIER',orderId,
    currentCourierId:row.courier_id};
  }
  // Re-check under lock; do not rely solely on the candidate SELECT.
  const count=await client.query<{n:string}>(
   "SELECT count(*)::text AS n FROM tala_logistics_v2.dispatch_reservations "+
   "WHERE courier_id=$1::uuid AND status='reserved'",[candidate.id]
  );
  if(Number(count.rows[0]!.n)>=candidate.capacity){
   await client.query('COMMIT');
   return {decision:'NO_AVAILABLE_COURIER',orderId,
    currentCourierId:row.courier_id};
  }
  const changed=await client.query<{version:string;courier_id:string}>(
   "UPDATE tala_logistics_v2.dispatch_reservations "+
   "SET courier_id=$2::uuid,version=version+1,updated_at=clock_timestamp() "+
   "WHERE order_id=$1::uuid AND version=$3::bigint AND status='reserved' "+
   "RETURNING version,courier_id",[orderId,candidate.id,expectedVersion]
  );
  const updated=changed.rows[0];
  if(!updated)throw new LogisticsError('LOGISTICS_VERSION_CONFLICT');
  // The Orders update is part of this SQL transaction: any rejection or
  // exception rolls back the courier swap, event and outbox.
  const synchronized=await commitOrdersReassignment!(client,{
    orderId,restaurantId:row.restaurant_id,previousCourierId:row.courier_id,
    courierId:candidate.id,zone:row.zone,logisticsVersion:updated.version,
    commandKey
  });
  if(synchronized!==true)reject('LOGISTICS_ORDER_SYNC_FAILED');

  const details={orderId,previousCourierId:row.courier_id,courierId:candidate.id,
   status:'reserved',version:updated.version,
   dispatchEngine:'TALA Dispatch Engine',dispatchEngineVersion:TALA_GEO_VERSION,
   dispatchMethod:'proximity',rerouteReason:'PREVIOUS_COURIER_UNAVAILABLE',
   commandDigest:digest};
  const eventKey=createHash('sha256').update(
   ['logistics.v2',orderId,commandKey,'dispatch.reassigned'].join('|')
  ).digest('hex');
  await client.query(
   "INSERT INTO tala_logistics_v2.dispatch_events "+
   "(order_id,command_key,event_type,courier_id,event_key,details) "+
   "VALUES($1::uuid,$2,'dispatch.reassigned',$3::uuid,$4,$5::jsonb)",
   [orderId,commandKey,candidate.id,eventKey,JSON.stringify(details)]
  );
  await client.query(
   "INSERT INTO tala_logistics_v2.outbox(event_key,event_type,payload) "+
   "VALUES($1,'dispatch.reassigned',$2::jsonb)",[eventKey,JSON.stringify(details)]
  );
  await client.query('COMMIT');
  return {decision:'REASSIGNED',orderId,previousCourierId:row.courier_id,
   courierId:candidate.id,version:updated.version,replayed:false};
 }catch(error){await client.query('ROLLBACK');throw error;}
 finally{client.release();}
}
