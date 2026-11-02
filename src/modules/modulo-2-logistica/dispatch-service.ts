/**
 * TALA EATS CORE v2 / Module 2: transactional logistics LAB.
 * Privileged internal service only. Never mount an HTTP route in this phase.
 * A trusted Orders adapter must establish order status/identity before calling
 * reserveDelivery. We do not read or update Module 1 tables.
 */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {DeliveryAssignmentRequest} from './contracts.ts';
import {TALA_DISPATCH_ENGINE_VERSION,evaluateTalaDispatch,isDispatchTriggerReady}
  from './tala-dispatch-engine.ts';
import {TALA_GEO_VERSION,validGeoPoint,type GeoPoint} from './geo.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone=/^[a-z0-9][a-z0-9_-]{1,63}$/;
const keyFormat=/^[a-zA-Z0-9_.:-]{16,128}$/;
const bad=(code:string):never=>{throw new LogisticsError(code);};
export class LogisticsError extends Error{
  readonly code:string;
  constructor(code:string){super(code);this.code=code;this.name='LogisticsError';}
}
function requireId(id:string):string{
  if(typeof id!=='string'||!uuid.test(id))return bad('LOGISTICS_ID_INVALID');
  return id.toLowerCase();
}
function requireKey(key:string):void{
  if(typeof key!=='string'||!keyFormat.test(key))bad('LOGISTICS_COMMAND_KEY_INVALID');
}
function requireZone(value:string):void{
  if(typeof value!=='string'||!zone.test(value))bad('LOGISTICS_ZONE_INVALID');
}
function eventKey(orderId:string,commandKey:string,action:string):string{
  return createHash('sha256').update(
    ['logistics.v1',orderId,commandKey,action].join('|')
  ).digest('hex');
}
async function start(client:PoolClient):Promise<void>{
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '3000ms'");
  await client.query("SET LOCAL statement_timeout = '10000ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '15000ms'");
}
/** Optional internal-only Geo v2 candidate ranking. No public HTTP caller.
 * The provided restaurant point must be established by a trusted Orders adapter. */
export type GeoDispatchOptions=Readonly<{
  restaurant:GeoPoint;
  maxDistanceMeters:number;
}>;
type CourierRow={id:string;capacity:number;active:number};
type ReservationRow={order_id:string;restaurant_id:string;zone:string;
  courier_id:string;status:'reserved'|'released'|'completed';version:string};
export type DispatchResult={orderId:string;courierId:string;
  status:'reserved'|'released'|'completed';version:string;replayed:boolean};
export type DispatchDecision=
  | ({decision:'RESERVED'} & DispatchResult)
  | {decision:'NO_AVAILABLE_COURIER'|'NOT_ELIGIBLE';orderId:string};

/** Staff-only enrollment, not a public registration or authorisation route. */
export async function enrollCourier(pool:Pool,courierId:string,deliveryZone:string,capacity=1):
  Promise<void>{
  courierId=requireId(courierId);requireZone(deliveryZone);
  if(!Number.isSafeInteger(capacity)||capacity<1||capacity>5)
    bad('LOGISTICS_CAPACITY_INVALID');
  await pool.query(
    'INSERT INTO tala_logistics_v2.couriers(id,zone,capacity) VALUES($1::uuid,$2,$3)',
    [courierId,deliveryZone,capacity]
  );
}
/** Staff-only approval control; revocation forces courier offline. */
export async function approveCourier(pool:Pool,courierId:string,approved:boolean):
  Promise<void>{
  courierId=requireId(courierId);
  if(typeof approved!=='boolean')bad('LOGISTICS_APPROVAL_INVALID');
  const r=await pool.query(
    `UPDATE tala_logistics_v2.couriers
     SET approved=$2,online=CASE WHEN $2 THEN online ELSE false END,
         updated_at=clock_timestamp()
     WHERE id=$1::uuid RETURNING id`,[courierId,approved]
  );
  if(!r.rowCount)bad('LOGISTICS_COURIER_NOT_FOUND');
}
/** Authenticated-driver adapter required later; server stamps heartbeat time. */
export async function setCourierOnline(pool:Pool,courierId:string,online:boolean):
  Promise<void>{
  courierId=requireId(courierId);
  if(typeof online!=='boolean')bad('LOGISTICS_PRESENCE_INVALID');
  const r=await pool.query(
    `UPDATE tala_logistics_v2.couriers
     SET online=$2,last_seen_at=CASE WHEN $2 THEN clock_timestamp()
                                     ELSE last_seen_at END,
         updated_at=clock_timestamp()
     WHERE id=$1::uuid AND approved=true RETURNING id`,[courierId,online]
  );
  if(!r.rowCount)bad('LOGISTICS_COURIER_NOT_APPROVED');
}
async function logEvent(client:PoolClient,row:ReservationRow,commandKey:string,
  type:'dispatch.reserved'|'dispatch.released'|'dispatch.completed',
  method:'capacity'|'proximity'='capacity'){
  const k=eventKey(row.order_id,commandKey,type);
  const payload={orderId:row.order_id,courierId:row.courier_id,
    status:row.status,version:row.version,
    dispatchEngine:'TALA Dispatch Engine',
    dispatchEngineVersion:method==='proximity'?TALA_GEO_VERSION:TALA_DISPATCH_ENGINE_VERSION,
    dispatchMethod:method};
  await client.query(
    `INSERT INTO tala_logistics_v2.dispatch_events
      (order_id,command_key,event_type,courier_id,event_key,details)
      VALUES($1::uuid,$2,$3,$4::uuid,$5,$6::jsonb)`,
    [row.order_id,commandKey,type,row.courier_id,k,JSON.stringify(payload)]
  );
  await client.query(
    `INSERT INTO tala_logistics_v2.outbox(event_key,event_type,payload)
      VALUES($1,$2,$3::jsonb)`,
    [k,type,JSON.stringify(payload)]
  );
}
/** Atomic reservation, with row locks per courier and per-order advisory lock.
 * Only consumes a trusted Orders 'ready' event. Not a commercial assignment. */
export async function reserveDelivery(pool:Pool,
  request:DeliveryAssignmentRequest,commandKey:string,
  geo?:GeoDispatchOptions):Promise<DispatchDecision>{
  if(!request)return bad('LOGISTICS_REQUEST_INVALID');
  const orderId=requireId(request.orderId),restaurantId=requireId(request.restaurantId);
  requireZone(request.deliveryZone);requireKey(commandKey);
  if(geo!==undefined && (!geo || !validGeoPoint(geo.restaurant)
    || !Number.isFinite(geo.maxDistanceMeters)
    || geo.maxDistanceMeters<=0 || geo.maxDistanceMeters>100000))
    bad('LOGISTICS_GEO_REQUEST_INVALID');
  if(!isDispatchTriggerReady(request))
    return {decision:'NOT_ELIGIBLE',orderId};
  const client=await pool.connect();
  try{
    await start(client);
    // Identical order requests serialize even when no reservation row exists.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 20261101))',[orderId]
    );
    const old=await client.query<ReservationRow>(
      'SELECT * FROM tala_logistics_v2.dispatch_reservations WHERE order_id=$1::uuid FOR UPDATE',[orderId]
    );
    if(old.rows[0]){
      const row=old.rows[0];
      if(row.restaurant_id!==restaurantId||row.zone!==request.deliveryZone)
        bad('LOGISTICS_ORDER_CONFLICT');
      if(row.status!=='reserved')bad('LOGISTICS_DISPATCH_FINALIZED');
      const previous=await client.query<{event_type:string}>(
        `SELECT event_type FROM tala_logistics_v2.dispatch_events
         WHERE order_id=$1::uuid AND command_key=$2`,[orderId,commandKey]
      );
      if(previous.rows[0]?.event_type==='dispatch.reserved'){
        await client.query('COMMIT');
        return {decision:'RESERVED',orderId,courierId:row.courier_id,
          status:'reserved',version:row.version,replayed:true};
      }
      bad('LOGISTICS_ORDER_ALREADY_RESERVED');
    }
    // SKIP LOCKED prevents competing orders from simultaneously claiming
    // a courier. Capacity is rechecked AFTER acquiring the courier lock.
    // Each courier position writer first locks its courier row. This lock
    // therefore freezes location and capacity while the reservation commits.
    // Geo mode also rejects missing/stale GPS and prefers shortest Haversine
    // distance to the trusted restaurant point. Never fake road ETA.
    const haversine=`
      6371008.8 * 2 * asin(sqrt(least(1.0,
        power(sin(radians(p.latitude - $2::double precision)/2),2)
        + cos(radians($2::double precision))*cos(radians(p.latitude))
        * power(sin(radians(p.longitude - $3::double precision)/2),2)
      )))`;
    const candidateSql=geo?
      `SELECT c.id,c.capacity,c.zone,c.approved,c.online,c.last_seen_at
         FROM tala_logistics_v2.couriers c
         JOIN tala_logistics_v2.courier_positions p ON p.courier_id=c.id
        WHERE c.approved=true AND c.online=true AND c.zone=$1
          AND c.last_seen_at BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp()
          AND p.observed_at BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp()
          AND p.accuracy_m<=100
          AND (SELECT count(*) FROM tala_logistics_v2.dispatch_reservations d
                WHERE d.courier_id=c.id AND d.status='reserved') < c.capacity
          AND (${haversine}) <= $4::double precision
        ORDER BY (${haversine}) ASC,
          (SELECT count(*) FROM tala_logistics_v2.dispatch_reservations d
           WHERE d.courier_id=c.id AND d.status='reserved'),c.id
        FOR UPDATE OF c SKIP LOCKED LIMIT 1`:
      `SELECT c.id,c.capacity,c.zone,c.approved,c.online,c.last_seen_at
       FROM tala_logistics_v2.couriers c
       WHERE c.approved=true AND c.online=true AND c.zone=$1
         AND c.last_seen_at>=clock_timestamp()-interval '120 seconds'
         AND c.last_seen_at<=clock_timestamp()
         AND (SELECT count(*) FROM tala_logistics_v2.dispatch_reservations d
              WHERE d.courier_id=c.id AND d.status='reserved') < c.capacity
       ORDER BY (SELECT count(*) FROM tala_logistics_v2.dispatch_reservations d
                  WHERE d.courier_id=c.id AND d.status='reserved'),c.id
       FOR UPDATE OF c SKIP LOCKED LIMIT 1`;
    const candidate=await client.query<{
      id:string;capacity:number;zone:string;approved:boolean;
      online:boolean;last_seen_at:Date|null;
    }>(candidateSql,geo?[request.deliveryZone,geo.restaurant.latitude,
        geo.restaurant.longitude,geo.maxDistanceMeters]:[request.deliveryZone]);
    const courier=candidate.rows[0];
    if(!courier){
      await client.query('COMMIT');
      return {decision:'NO_AVAILABLE_COURIER',orderId};
    }
    const load=await client.query<{count:string}>(
      `SELECT count(*)::text AS count FROM tala_logistics_v2.dispatch_reservations
       WHERE courier_id=$1::uuid AND status='reserved'`,[courier.id]
    );
    // TALA: re-evaluate availability and capacity under the acquired
    // courier row lock. The pure engine only PROPOSES; SQL is authoritative.
    const verdict=evaluateTalaDispatch(request,[{
      courierId:courier.id,approved:courier.approved,online:courier.online,
      serviceZones:[courier.zone],activeDeliveries:Number(load.rows[0]!.count),
      maxConcurrentDeliveries:courier.capacity,
      lastSeenAtMs:courier.last_seen_at?.getTime()??0
    }],Date.now());
    if(verdict.decision!=='PROPOSE'||verdict.courierId!==courier.id){
      await client.query('COMMIT');
      return {decision:'NO_AVAILABLE_COURIER',orderId};
    }
    const inserted=await client.query<ReservationRow>(
      `INSERT INTO tala_logistics_v2.dispatch_reservations
        (order_id,restaurant_id,zone,courier_id,status)
        VALUES($1::uuid,$2::uuid,$3,$4::uuid,'reserved') RETURNING *`,
      [orderId,restaurantId,request.deliveryZone,courier.id]
    );
    const row=inserted.rows[0]!;
    await logEvent(client,row,commandKey,'dispatch.reserved',geo?'proximity':'capacity');
    await client.query('COMMIT');
    return {decision:'RESERVED',orderId,courierId:row.courier_id,
      status:'reserved',version:row.version,replayed:false};
  }catch(err){await client.query('ROLLBACK');throw err;}
  finally{client.release();}
}
/** Ends the logistics capacity reservation only after a trusted completion
 * or release decision. Does NOT transition the order or settle funds. */
export async function finalizeDispatch(pool:Pool,order:string,
  expectedVersion:string,commandKey:string,
  target:'completed'|'released'):Promise<DispatchResult>{
  const orderId=requireId(order);requireKey(commandKey);
  if(typeof expectedVersion!=='string'||!/^[1-9][0-9]{0,15}$/.test(expectedVersion)
     ||!['completed','released'].includes(target))
    bad('LOGISTICS_FINALIZE_INVALID');
  const client=await pool.connect();
  try{
    await start(client);
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 20261101))',[orderId]
    );
    const r=await client.query<ReservationRow>(
      `SELECT * FROM tala_logistics_v2.dispatch_reservations
       WHERE order_id=$1::uuid FOR UPDATE`,[orderId]
    );
    const row=r.rows[0];
    if(!row)throw new LogisticsError('LOGISTICS_DISPATCH_NOT_FOUND');
    const earlier=await client.query<{event_type:string;details:{version:string;status:string;courierId:string}}>(
      `SELECT event_type,details FROM tala_logistics_v2.dispatch_events
       WHERE order_id=$1::uuid AND command_key=$2`,[orderId,commandKey]
    );
    const old=earlier.rows[0];
    const type=target==='completed'?'dispatch.completed':'dispatch.released';
    if(old){
      if(old.event_type!==type)bad('LOGISTICS_IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT');
      return {orderId,courierId:old.details.courierId,
        status:target,version:old.details.version,replayed:true};
    }
    if(row.status!=='reserved')bad('LOGISTICS_DISPATCH_FINALIZED');
    if(row.version!==expectedVersion)bad('LOGISTICS_VERSION_CONFLICT');
    const final=await client.query<ReservationRow>(
      `UPDATE tala_logistics_v2.dispatch_reservations
       SET status=$2,version=version+1,updated_at=clock_timestamp()
       WHERE order_id=$1::uuid AND version=$3::bigint RETURNING *`,
      [orderId,target,expectedVersion]
    );
    const updated=final.rows[0];
    if(!updated)throw new LogisticsError('LOGISTICS_VERSION_CONFLICT');
    await logEvent(client,updated,commandKey,type);
    await client.query('COMMIT');
    return {orderId,courierId:row.courier_id,status:target,
      version:updated.version,replayed:false};
  }catch(err){await client.query('ROLLBACK');throw err;}
  finally{client.release();}
}
