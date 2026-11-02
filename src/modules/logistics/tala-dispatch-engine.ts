/**
 * TALA DISPATCH ENGINE — LAB2 (private internal worker, no public dispatcher).
 * FIFO cash delivery offers + fair online drivers. Never invent ETA/distance:
 * restaurant coordinates and travel-time provider are not integrated.
 */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {transitionOrder,OrderTransitionError} from '../orders/order-machine.ts';
export class DispatchError extends Error{
  readonly code:string;
  constructor(code:string){super(code);this.code=code;this.name='DispatchError';}
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const commandRe=/^[A-Za-z0-9_.:-]{16,128}$/;
const OFFER_SECONDS=60;
type Order={id:string;status:string;fulfillment:'pickup'|'delivery';
  payment_method:'cash'|'stripe';payment_status:string;version:string};
type Offer={id:string;order_id:string;driver_id:string;state:string;
  expected_order_version:string;accepted_order_version:string|null;expires_at:Date;
  expired?:boolean;is_live?:boolean};
async function begin(c:PoolClient){
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout='3000ms'");
  await c.query("SET LOCAL statement_timeout='10000ms'");
  await c.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
}
async function lockOrder(c:PoolClient,id:string,skip=false){
  const r=await c.query<Order>(
    'SELECT id,status,fulfillment,payment_method,payment_status,version FROM tala_core_v2.orders WHERE id=$1::uuid FOR UPDATE'+(skip?' SKIP LOCKED':''),[id]);
  return r.rows[0]??null;
}
const eventKey=(name:string,id:string)=>createHash('sha256').update(name+'|'+id).digest('hex');
async function audit(c:PoolClient,order:Order,offerId:string,driverId:string,
  eventType:string,from:string,to:string,version:string){
  const k=eventKey(eventType,offerId);
  await c.query(`
    INSERT INTO tala_core_v2.order_events
      (order_id,event_key,previous_status,new_status,actor_role,actor_id,data)
    VALUES($1::uuid,$2,$3,$4,'system',NULL,$5::jsonb)`,
    [order.id,k,from,to,JSON.stringify({dispatchOfferId:offerId,driverId,version})]);
  await c.query(`
    INSERT INTO tala_core_v2.outbox(aggregate_id,event_key,event_type,payload)
    VALUES($1::uuid,$2,$3,$4::jsonb)`,
    [order.id,k,eventType,JSON.stringify({orderId:order.id,offerId,driverId,from,to,version})]);
}
/** Expire in bounded batches, always lock order BEFORE offer. */
export async function expireDispatchOffers(pool:Pool,limit=20){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new DispatchError('LIMIT_INVALID');
  const ids=await pool.query<{id:string;order_id:string}>(`
    SELECT id,order_id FROM tala_core_v2.dispatch_offers
    WHERE state='offered' AND expires_at<=now()
    ORDER BY expires_at,id LIMIT $1`,[limit]);
  let expired=0;
  for(const item of ids.rows){
    const c=await pool.connect();
    try{
      await begin(c);
      const o=await lockOrder(c,item.order_id,true);
      if(!o){await c.query('ROLLBACK');continue;}
      const r=await c.query<Offer>(
        'SELECT *, expires_at<=clock_timestamp() AS expired FROM tala_core_v2.dispatch_offers WHERE id=$1::uuid FOR UPDATE',[item.id]);
      const offer=r.rows[0];
      if(!offer||offer.state!=='offered'||offer.expired!==true){
        await c.query('COMMIT');continue;
      }
      await c.query(`
        UPDATE tala_core_v2.dispatch_offers SET state='expired',decided_at=now()
        WHERE id=$1::uuid`,[offer.id]);
      await audit(c,o,offer.id,offer.driver_id,'dispatch.offer.expired',o.status,o.status,o.version);
      await c.query('COMMIT');expired++;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  return expired;
}
/** Trusted scope allows one market/cohort; no arbitrary HTTP-selected scope. */
export type DispatchScope={orderIds?:string[];driverIds?:string[]};
/** Worker makes ONE 60-second offer, never auto-assigns an unconsenting driver. */
export async function dispatchNext(pool:Pool,scope:DispatchScope={},retry=0):Promise<
  {state:'offered';offerId:string;orderId:string;driverId:string;expiresAt:string}
  |{state:'idle'|'no_driver';orderId?:string}>{
  for(const ids of [scope.orderIds,scope.driverIds]){
    if(ids!==undefined&&(!Array.isArray(ids)||ids.length>100||
      ids.some(id=>typeof id!=='string'||!uuid.test(id))))
      throw new DispatchError('DISPATCH_SCOPE_INVALID');
  }
  await expireDispatchOffers(pool);
  const c=await pool.connect();
  try{
    await begin(c);
    const r=await c.query<Order>(`
      SELECT o.id,o.status,o.fulfillment,o.payment_method,o.payment_status,o.version
      FROM tala_core_v2.orders o
      WHERE o.status='ready' AND o.fulfillment='delivery'
        AND o.payment_method='cash' AND o.payment_status='pending'
        AND NOT EXISTS(SELECT 1 FROM tala_core_v2.order_driver_assignments a WHERE a.order_id=o.id)
        AND NOT EXISTS(SELECT 1 FROM tala_core_v2.dispatch_offers f
          WHERE f.order_id=o.id AND f.state='offered')
        AND (SELECT count(*) FROM tala_core_v2.dispatch_offers h WHERE h.order_id=o.id)<10
        AND ($1::uuid[] IS NULL OR o.id=ANY($1::uuid[]))
      ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,[scope.orderIds??null]);
    const order=r.rows[0];
    if(!order){await c.query('COMMIT');return {state:'idle'};}
    const ds=await c.query<{account_id:string}>(`
      SELECT p.account_id FROM tala_core_v2.driver_profiles p
      JOIN tala_core_v2.accounts a ON a.id=p.account_id
      WHERE p.approved=true AND p.is_online=true AND a.is_active=true AND a.role='driver'
        AND p.max_active_deliveries=1
        AND p.dispatch_heartbeat_at>=now()-interval '90 seconds'
        AND NOT EXISTS(SELECT 1 FROM tala_core_v2.order_driver_assignments own
          JOIN tala_core_v2.orders busy ON busy.id=own.order_id
          WHERE own.driver_id=p.account_id
            AND busy.status IN ('assigned','picked_up','on_the_way'))
        AND NOT EXISTS(SELECT 1 FROM tala_core_v2.dispatch_offers pending
          WHERE pending.driver_id=p.account_id AND pending.state='offered')
        AND NOT EXISTS(SELECT 1 FROM tala_core_v2.dispatch_offers previous
          WHERE previous.driver_id=p.account_id AND previous.order_id=$1::uuid)
        AND ($2::uuid[] IS NULL OR p.account_id=ANY($2::uuid[]))
      ORDER BY p.last_dispatch_offer_at NULLS FIRST,p.presence_updated_at,p.account_id
      LIMIT 1 FOR UPDATE OF p SKIP LOCKED`,[order.id,scope.driverIds??null]);
    const driver=ds.rows[0];
    if(!driver){await c.query('COMMIT');return {state:'no_driver',orderId:order.id};}
    const rows=await c.query<{id:string;expires_at:Date}>(`
      INSERT INTO tala_core_v2.dispatch_offers
        (order_id,driver_id,expected_order_version,expires_at)
      VALUES($1::uuid,$2::uuid,$3::bigint,now()+($4::int*interval '1 second'))
      ON CONFLICT DO NOTHING
      RETURNING id,expires_at`,[order.id,driver.account_id,order.version,OFFER_SECONDS]);
    // READ COMMITTED can select a row based on a snapshot just before a
    // competing worker commits. A uniqueness conflict is not a worker crash.
    if(!rows.rows[0]){
      await c.query('ROLLBACK');
      return retry<3?dispatchNext(pool,scope,retry+1):{state:'idle'};
    }
    const offer=rows.rows[0];
    await c.query(
      'UPDATE tala_core_v2.driver_profiles SET last_dispatch_offer_at=now() WHERE account_id=$1::uuid',
      [driver.account_id]);
    await audit(c,order,offer.id,driver.account_id,'dispatch.offer.created',
      'ready','ready',order.version);
    await c.query('COMMIT');
    return {state:'offered',offerId:offer.id,orderId:order.id,driverId:driver.account_id,
      expiresAt:new Date(offer.expires_at).toISOString()};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function listDriverDispatchOffers(pool:Pool,driverId:string){
  if(!uuid.test(driverId))throw new DispatchError('DRIVER_INVALID');
  const r=await pool.query(`
    SELECT f.id AS "offerId",f.order_id AS "orderId",f.expires_at AS "expiresAt",
      o.version AS "expectedVersion",r.name AS "restaurantName"
    FROM tala_core_v2.dispatch_offers f
    JOIN tala_core_v2.orders o ON o.id=f.order_id
    JOIN tala_core_v2.restaurants r ON r.id=o.restaurant_id
    JOIN tala_core_v2.driver_profiles p ON p.account_id=f.driver_id
    JOIN tala_core_v2.accounts a ON a.id=f.driver_id
    WHERE f.driver_id=$1::uuid AND f.state='offered' AND f.expires_at>now()
      AND o.status='ready' AND o.version=f.expected_order_version
      AND p.approved=true AND p.is_online=true AND a.is_active=true AND a.role='driver'
      AND p.dispatch_heartbeat_at>=now()-interval '90 seconds'
    ORDER BY f.created_at,f.id LIMIT 10`,[driverId]);
  // Never expose buyer address, customer identity or GPS before acceptance.
  return r.rows;
}
async function lockOffer(c:PoolClient,id:string,driverId:string){
  const lookup=await c.query<{order_id:string}>(`
    SELECT order_id FROM tala_core_v2.dispatch_offers
    WHERE id=$1::uuid AND driver_id=$2::uuid`,[id,driverId]);
  if(!lookup.rows[0])throw new DispatchError('OFFER_NOT_FOUND');
  const order=await lockOrder(c,lookup.rows[0].order_id);
  if(!order)throw new DispatchError('OFFER_NOT_FOUND');
  const rows=await c.query<Offer>(`
    SELECT *, expires_at>clock_timestamp() AS is_live FROM tala_core_v2.dispatch_offers
    WHERE id=$1::uuid AND driver_id=$2::uuid FOR UPDATE`,[id,driverId]);
  if(!rows.rows[0])throw new DispatchError('OFFER_NOT_FOUND');
  return {order,offer:rows.rows[0]};
}
export async function acceptDispatchOffer(pool:Pool,driverId:string,offerId:string){
  if(!uuid.test(driverId)||!uuid.test(offerId))throw new DispatchError('OFFER_INVALID');
  const c=await pool.connect();
  try{
    await begin(c);
    const {order,offer}=await lockOffer(c,offerId,driverId);
    if(offer.state==='accepted'){
      const a=await c.query(`
        SELECT 1 FROM tala_core_v2.order_driver_assignments
        WHERE order_id=$1::uuid AND driver_id=$2::uuid`,[order.id,driverId]);
      if(!a.rowCount)throw new DispatchError('OFFER_NO_LONGER_ASSIGNED');
      await c.query('COMMIT');
      return {orderId:order.id,status:'assigned',version:offer.accepted_order_version,replayed:true};
    }
    if(offer.state!=='offered')throw new DispatchError('OFFER_ALREADY_CLOSED');
    if(offer.is_live!==true)
      throw new DispatchError('OFFER_EXPIRED');
    const p=await c.query<{is_online:boolean}>(`
      SELECT p.is_online FROM tala_core_v2.driver_profiles p
      JOIN tala_core_v2.accounts a ON a.id=p.account_id
      WHERE p.account_id=$1::uuid AND p.approved=true AND a.is_active=true AND a.role='driver'
      FOR UPDATE OF p FOR SHARE OF a`,[driverId]);
    if(!p.rows[0]?.is_online)throw new DispatchError('DRIVER_NOT_AVAILABLE');
    const beat=await c.query(
      "SELECT 1 FROM tala_core_v2.driver_profiles WHERE account_id=$1::uuid AND dispatch_heartbeat_at>=now()-interval '90 seconds'",
      [driverId]);
    if(!beat.rowCount)throw new DispatchError('DRIVER_HEARTBEAT_STALE');
    const busy=await c.query(`
      SELECT 1 FROM tala_core_v2.order_driver_assignments d
      JOIN tala_core_v2.orders o ON o.id=d.order_id
      WHERE d.driver_id=$1::uuid AND o.status IN ('assigned','picked_up','on_the_way')
      LIMIT 1`,[driverId]);
    if(busy.rowCount)throw new DispatchError('DRIVER_CAPACITY_EXCEEDED');
    if(order.status!=='ready'||order.fulfillment!=='delivery'||
      order.payment_method!=='cash'||order.payment_status!=='pending')
      throw new DispatchError('ORDER_NOT_DISPATCHABLE');
    if(BigInt(order.version)!==BigInt(offer.expected_order_version))
      throw new DispatchError('ORDER_VERSION_CONFLICT');
    try{transitionOrder({current:'ready',target:'assigned',fulfillment:'delivery',
      paymentMethod:'cash',actor:'system'});}
    catch(e){if(e instanceof OrderTransitionError)throw new DispatchError(e.code);throw e;}
    const existing=await c.query(
      'SELECT 1 FROM tala_core_v2.order_driver_assignments WHERE order_id=$1::uuid',[order.id]);
    if(existing.rowCount)throw new DispatchError('ORDER_ALREADY_ASSIGNED');
    await c.query(`
      INSERT INTO tala_core_v2.order_driver_assignments(order_id,driver_id)
      VALUES($1::uuid,$2::uuid)`,[order.id,driverId]);
    const updated=await c.query<{version:string}>(`
      UPDATE tala_core_v2.orders SET status='assigned',version=version+1,updated_at=now()
      WHERE id=$1::uuid RETURNING version`,[order.id]);
    const version=updated.rows[0]!.version;
    await c.query(`
      UPDATE tala_core_v2.dispatch_offers
      SET state='accepted',decided_at=now(),accepted_order_version=$2::bigint
      WHERE id=$1::uuid`,[offerId,version]);
    await audit(c,order,offerId,driverId,'dispatch.offer.accepted','ready','assigned',version);
    await c.query('COMMIT');
    return {orderId:order.id,status:'assigned',version,replayed:false};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function declineDispatchOffer(pool:Pool,driverId:string,offerId:string){
  if(!uuid.test(driverId)||!uuid.test(offerId))throw new DispatchError('OFFER_INVALID');
  const c=await pool.connect();
  try{
    await begin(c);
    const {order,offer}=await lockOffer(c,offerId,driverId);
    if(offer.state==='declined'){
      await c.query('COMMIT');return {declined:true,replayed:true};
    }
    if(offer.state!=='offered')throw new DispatchError('OFFER_ALREADY_CLOSED');
    if(offer.is_live!==true)
      throw new DispatchError('OFFER_EXPIRED');
    await c.query(`
      UPDATE tala_core_v2.dispatch_offers SET state='declined',decided_at=now()
      WHERE id=$1::uuid`,[offerId]);
    await audit(c,order,offerId,driverId,'dispatch.offer.declined',
      order.status,order.status,order.version);
    await c.query('COMMIT');
    return {declined:true,replayed:false};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

/**
 * Manual trusted recovery. Not mounted in HTTP. Never requeue picked-up,
 * on-the-way, PIN-generated, cash-attested or custody-settled deliveries.
 * Threshold protects against releasing a driver for a transient disconnect.
 */
export async function recoverUncollectedAssignment(
  pool:Pool,orderId:string,expectedVersion:bigint,commandKey:string){
  if(!uuid.test(orderId)||!commandRe.test(commandKey)||
    typeof expectedVersion!=='bigint'||expectedVersion<1n)
    throw new DispatchError('RECOVERY_INVALID');
  const k=eventKey('dispatch.manual.recovery.v1',orderId+'|'+commandKey);
  const c=await pool.connect();
  try{
    await begin(c);
    const order=await lockOrder(c,orderId);
    if(!order)throw new DispatchError('ORDER_NOT_FOUND');
    const previous=await c.query<{data:{expectedVersion?:string;version?:string}}>(`
      SELECT data FROM tala_core_v2.order_events
      WHERE order_id=$1::uuid AND event_key=$2`,[orderId,k]);
    if(previous.rows[0]){
      const prev=previous.rows[0].data;
      if(prev?.expectedVersion!==String(expectedVersion)||!prev.version)
        throw new DispatchError('IDEMPOTENCY_CONFLICT');
      await c.query('COMMIT');
      return {orderId,status:'ready',version:prev.version,replayed:true};
    }
    if(order.status!=='assigned'||order.fulfillment!=='delivery'||
      order.payment_method!=='cash'||order.payment_status!=='pending')
      throw new DispatchError('RECOVERY_FORBIDDEN');
    if(BigInt(order.version)!==expectedVersion)
      throw new DispatchError('ORDER_VERSION_CONFLICT');
    const assignment=await c.query<{driver_id:string}>(`
      SELECT driver_id FROM tala_core_v2.order_driver_assignments
      WHERE order_id=$1::uuid AND assigned_at<=now()-interval '20 minutes'
      FOR UPDATE`,[orderId]);
    if(!assignment.rows[0])throw new DispatchError('RECOVERY_NOT_DUE');
    const proof=await c.query(`
      SELECT 1 FROM tala_core_v2.order_handoffs
      WHERE order_id=$1::uuid AND (
        buyer_cash_ack_at IS NOT NULL OR custodian_cash_ack_at IS NOT NULL
        OR custodian_id IS NOT NULL OR pin_hash IS NOT NULL
        OR pin_consumed_at IS NOT NULL OR custody_settled_at IS NOT NULL
      )
      UNION ALL
      SELECT 1 FROM tala_core_v2.order_events
      WHERE order_id=$1::uuid AND (
        data ? 'failedAttemptsReset'
        OR (data ? 'side' AND data ? 'cashAmountMinor')
        OR new_status IN ('picked_up','on_the_way','delivered')
      )
      UNION ALL
      SELECT 1 FROM tala_core_v2.outbox
      WHERE aggregate_id=$1::uuid
        AND event_type IN ('order.pin.issued','order.cash.attested','order.delivered')
      LIMIT 1`,[orderId]);
    if(proof.rowCount)throw new DispatchError('RECOVERY_CUSTODY_REVIEW_REQUIRED');
    try{transitionOrder({current:'assigned',target:'ready',fulfillment:'delivery',
      paymentMethod:'cash',actor:'system',reassignmentAuthorized:true});}
    catch(e){if(e instanceof OrderTransitionError)throw new DispatchError(e.code);throw e;}
    await c.query('DELETE FROM tala_core_v2.order_driver_assignments WHERE order_id=$1::uuid',[orderId]);
    const updated=await c.query<{version:string}>(`
      UPDATE tala_core_v2.orders SET status='ready',version=version+1,updated_at=now()
      WHERE id=$1::uuid RETURNING version`,[orderId]);
    const version=updated.rows[0]!.version;
    await c.query(`
      INSERT INTO tala_core_v2.order_events
        (order_id,event_key,previous_status,new_status,actor_role,data)
      VALUES($1::uuid,$2,'assigned','ready','system',$3::jsonb)`,
      [orderId,k,JSON.stringify({expectedVersion:String(expectedVersion),version,
        reason:'manual_timeout_before_pickup',driverId:assignment.rows[0].driver_id})]);
    await c.query(`
      INSERT INTO tala_core_v2.outbox(aggregate_id,event_key,event_type,payload)
      VALUES($1::uuid,$2,'dispatch.assignment.recovered',$3::jsonb)`,
      [orderId,k,JSON.stringify({orderId,version,previousDriverId:assignment.rows[0].driver_id})]);
    await c.query('DELETE FROM tala_core_v2.driver_latest_locations WHERE driver_id=$1::uuid',
      [assignment.rows[0].driver_id]);
    await c.query('COMMIT');
    return {orderId,status:'ready',version,replayed:false};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
