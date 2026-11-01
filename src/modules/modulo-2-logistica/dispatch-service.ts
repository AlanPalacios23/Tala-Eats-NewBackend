/**
 * TALA EATS CORE v2 / Module 2: transactional logistics LAB.
 * Privileged internal service only. Never mount an HTTP route in this phase.
 * A trusted Orders adapter must establish order status/identity before calling
 * reserveDelivery. We do not read or update Module 1 tables.
 */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {DeliveryAssignmentRequest} from './contracts.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  type:'dispatch.reserved'|'dispatch.released'|'dispatch.completed'){
  const k=eventKey(row.order_id,commandKey,type);
  const payload={orderId:row.order_id,courierId:row.courier_id,
    status:row.status,version:row.version};
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
  request:DeliveryAssignmentRequest,commandKey:string):Promise<DispatchDecision>{
  if(!request)return bad('LOGISTICS_REQUEST_INVALID');
  const orderId=requireId(request.orderId),restaurantId=requireId(request.restaurantId);
  requireZone(request.deliveryZone);requireKey(commandKey);
  if(request.fulfillment!=='delivery'||request.orderStatus!=='ready')
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
    const candidate=await client.query<{id:string;capacity:number}>(
      `SELECT c.id,c.capacity FROM tala_logistics_v2.couriers c
       WHERE c.approved=true AND c.online=true AND c.zone=$1
         AND c.last_seen_at>=clock_timestamp()-interval '120 seconds'
         AND c.last_seen_at<=clock_timestamp()
       ORDER BY (SELECT count(*) FROM tala_logistics_v2.dispatch_reservations d
                  WHERE d.courier_id=c.id AND d.status='reserved'),c.id
       FOR UPDATE OF c SKIP LOCKED LIMIT 1`,[request.deliveryZone]
    );
    const courier=candidate.rows[0];
    if(!courier){
      await client.query('COMMIT');
      return {decision:'NO_AVAILABLE_COURIER',orderId};
    }
    const load=await client.query<{count:string}>(
      `SELECT count(*)::text AS count FROM tala_logistics_v2.dispatch_reservations
       WHERE courier_id=$1::uuid AND status='reserved'`,[courier.id]
    );
    if(Number(load.rows[0]!.count)>=courier.capacity){
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
    await logEvent(client,row,commandKey,'dispatch.reserved');
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
    if(!row)bad('LOGISTICS_DISPATCH_NOT_FOUND');
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
    if(!final.rows[0])bad('LOGISTICS_VERSION_CONFLICT');
    await logEvent(client,final.rows[0],commandKey,type);
    await client.query('COMMIT');
    return {orderId,courierId:row.courier_id,status:target,
      version:final.rows[0].version,replayed:false};
  }catch(err){await client.query('ROLLBACK');throw err;}
  finally{client.release();}
}
