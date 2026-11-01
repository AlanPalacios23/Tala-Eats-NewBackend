import type {DeliveryAssignmentRequest,CourierCapacity,AssignmentPlan} from './contracts.ts';

/**
 * Pure, deterministic logistics candidate selection.
 * No writes, no DB access, no cash flow, no order status transition.
 * Module 1 stays responsible for atomic assignment, order lifecycle
 * and proof of delivery until a separately tested adapter is introduced.
 */
const id=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone=/^[a-z0-9][a-z0-9_-]{1,63}$/;
export function planCourierAssignment(
  request:DeliveryAssignmentRequest,
  couriers:readonly CourierCapacity[],
  nowMs:number
):AssignmentPlan{
  if(!request || !id.test(request.orderId) || !id.test(request.restaurantId)
     || !zone.test(request.deliveryZone)||!Number.isSafeInteger(nowMs)||nowMs<1
     || !Array.isArray(couriers) || couriers.length>500)
    throw Error('LOGISTICS_REQUEST_INVALID');
  if(request.fulfillment!=='delivery'||request.orderStatus!=='ready')
    return {decision:'NOT_ELIGIBLE',orderId:request.orderId};
  const eligible=couriers.filter(c=>
    c!=null&&typeof c.courierId==='string'&&id.test(c.courierId)
    &&c.approved===true&&c.online===true
    &&Array.isArray(c.serviceZones)&&c.serviceZones.includes(request.deliveryZone)
    &&Number.isSafeInteger(c.activeDeliveries)&&c.activeDeliveries>=0
    &&Number.isSafeInteger(c.maxConcurrentDeliveries)&&c.maxConcurrentDeliveries>=1
    &&c.activeDeliveries<c.maxConcurrentDeliveries
    &&Number.isSafeInteger(c.lastSeenAtMs)&&c.lastSeenAtMs<=nowMs
    &&nowMs-c.lastSeenAtMs<=120_000
  ).sort((a,b)=>a.activeDeliveries-b.activeDeliveries
    ||a.courierId.toLowerCase().localeCompare(b.courierId.toLowerCase()));
  const courier=eligible[0];
  return courier
    ? {decision:'ASSIGN',orderId:request.orderId,courierId:courier.courierId}
    : {decision:'NO_AVAILABLE_COURIER',orderId:request.orderId};
}
