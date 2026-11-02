/**
 * BOUNDARY ADAPTER — reads Module 1; Module 2 never imports Orders.
 * Must run on the exact PoolClient/transaction used by Logistics.
 * This is not HTTP authentication: only a trusted backend may invoke it.
 */
import type {VerifyPrePickup} from '../../modules/modulo-2-logistica/geo-reroute-service.ts';

/** Deny unless an actual delivery order is assigned to this same driver,
 * and both current state and immutable evidence rule out any pickup. */
export const verifyOrdersPrePickup:VerifyPrePickup=async(client,context)=>{
  const order=await client.query<{id:string;status:string;fulfillment:string}>(
    `SELECT id,status,fulfillment FROM tala_core_v2.orders
     WHERE id=$1::uuid AND restaurant_id=$2::uuid
     FOR SHARE`,[context.orderId,context.restaurantId]
  );
  if(order.rows[0]?.fulfillment!=='delivery' || order.rows[0]?.status!=='assigned')
    return false;
  const claim=await client.query<{driver_id:string}>(
    `SELECT driver_id FROM tala_core_v2.order_driver_assignments
     WHERE order_id=$1::uuid FOR SHARE`,[context.orderId]
  );
  if(claim.rows[0]?.driver_id!==context.courierId)return false;
  const proof=await client.query<{seen:boolean}>(
    `SELECT EXISTS(
       SELECT 1 FROM tala_core_v2.order_events e
        WHERE e.order_id=$1::uuid
          AND e.new_status IN ('picked_up','on_the_way','delivered')
     ) OR EXISTS(
       SELECT 1 FROM tala_core_v2.order_handoffs h
        WHERE h.order_id=$1::uuid AND h.pin_consumed_at IS NOT NULL
     ) AS seen`,[context.orderId]
  );
  return proof.rows[0]?.seen===false;
};
