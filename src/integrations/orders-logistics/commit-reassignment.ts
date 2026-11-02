/** Trusted same-transaction coordination adapter between Orders and Logistics.
 * Not an HTTP entrypoint, not callable by browsers. Both modules remain separate.
 * Called only AFTER verifyOrdersPrePickup held the M1 order lock.
 */
import {createHash} from 'node:crypto';
import type {CommitOrdersReassignment} from '../../modules/modulo-2-logistica/geo-reroute-service.ts';

/** Fail closed if M1's current actor/ownership or pickup state changed.
 * All statements share the exact PoolClient and rollback with M2 on failure. */
export const commitOrdersReassignment:CommitOrdersReassignment=async(client,ctx)=>{
  const next=await client.query<{id:string}>(
    `SELECT a.id FROM tala_core_v2.accounts a
       JOIN tala_core_v2.driver_profiles p ON p.account_id=a.id
       WHERE a.id=$1::uuid AND a.role='driver' AND a.is_active=true
         AND p.approved=true
       FOR SHARE OF a,p`,[ctx.courierId]
  );
  if(!next.rows[0])return false;
  const assignment=await client.query<{driver_id:string}>(
    `SELECT driver_id FROM tala_core_v2.order_driver_assignments
       WHERE order_id=$1::uuid FOR UPDATE`,[ctx.orderId]
  );
  if(assignment.rows[0]?.driver_id!==ctx.previousCourierId)return false;
  const order=await client.query<{version:string}>(
    `SELECT version FROM tala_core_v2.orders
       WHERE id=$1::uuid AND restaurant_id=$2::uuid
         AND fulfillment='delivery' AND status='assigned'
       FOR UPDATE`,[ctx.orderId,ctx.restaurantId]
  );
  if(!order.rows[0])return false;
  const evidence=await client.query<{picked_up:boolean}>(
    `SELECT EXISTS(
      SELECT 1 FROM tala_core_v2.order_events
       WHERE order_id=$1::uuid
         AND new_status IN ('picked_up','on_the_way','delivered')
     ) OR EXISTS(
      SELECT 1 FROM tala_core_v2.order_handoffs
       WHERE order_id=$1::uuid AND pin_consumed_at IS NOT NULL
     ) AS picked_up`,[ctx.orderId]
  );
  if(evidence.rows[0]?.picked_up!==false)return false;
  const updated=await client.query<{driver_id:string}>(
    `UPDATE tala_core_v2.order_driver_assignments
       SET driver_id=$3::uuid,assigned_at=clock_timestamp()
       WHERE order_id=$1::uuid AND driver_id=$2::uuid
       RETURNING driver_id`,
    [ctx.orderId,ctx.previousCourierId,ctx.courierId]
  );
  if(updated.rows[0]?.driver_id!==ctx.courierId)return false;
  const version=await client.query<{version:string}>(
    `UPDATE tala_core_v2.orders
       SET version=version+1,updated_at=clock_timestamp()
       WHERE id=$1::uuid AND version=$2::bigint AND status='assigned'
       RETURNING version`,[ctx.orderId,order.rows[0].version]
  );
  if(!version.rows[0])return false;
  const eventKey=createHash('sha256').update(
    ['orders.logistics.reroute.v1',ctx.orderId,ctx.commandKey].join('|')
  ).digest('hex');
  const data={
    previousCourierId:ctx.previousCourierId,
    courierId:ctx.courierId,
    orderVersion:version.rows[0].version,
    logisticsVersion:ctx.logisticsVersion
  };
  await client.query(
    `INSERT INTO tala_core_v2.order_events
       (order_id,event_key,previous_status,new_status,actor_role,data)
       VALUES($1::uuid,$2,'assigned','assigned','system',$3::jsonb)`,
    [ctx.orderId,eventKey,JSON.stringify(data)]
  );
  await client.query(
    `INSERT INTO tala_core_v2.outbox
       (aggregate_id,event_key,event_type,payload)
       VALUES($1::uuid,$2,'order.driver.reassigned',$3::jsonb)`,
    [ctx.orderId,eventKey,JSON.stringify({
      orderId:ctx.orderId,version:version.rows[0].version,
      previousCourierId:ctx.previousCourierId,courierId:ctx.courierId
    })]
  );
  return true;
};
