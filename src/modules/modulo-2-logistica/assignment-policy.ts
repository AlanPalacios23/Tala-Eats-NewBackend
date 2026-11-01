import type {DeliveryAssignmentRequest,CourierCapacity,AssignmentPlan} from './contracts.ts';
import {evaluateTalaDispatch} from './tala-dispatch-engine.ts';

/** Compatibility facade: the TALA Dispatch Engine now owns selection rules.
 * This only proposes a courier; it does not reserve or alter an order. */
export function planCourierAssignment(
  request:DeliveryAssignmentRequest,
  couriers:readonly CourierCapacity[],
  nowMs:number
):AssignmentPlan{
  try{
    const decision=evaluateTalaDispatch(request,couriers,nowMs);
    if(decision.decision==='PROPOSE'){
      return {decision:'ASSIGN',orderId:decision.orderId,
        courierId:decision.courierId!};
    }
    return {decision:decision.decision,orderId:decision.orderId};
  }catch{
    // Preserve the preexisting public error contract for old LAB1 clients.
    throw Error('LOGISTICS_REQUEST_INVALID');
  }
}
