import type {DeliveryAssignmentRequest,CourierCapacity} from './contracts.ts';

/**
 * TALA Dispatch Engine v1 — an internal methodology for Module 2.
 *
 * T = Trigger: accept only a ready, delivery order from a trusted adapter.
 * A = Availability: approved, online, same zone, fresh server heartbeat.
 * L = Load: at least one free slot; prioritize lowest active delivery count.
 * A = Atomic assignment: merely PROPOSE a candidate here; PostgreSQL
 *     must revalidate under row locks before writing a reservation.
 *
 * This is a deterministic, side-effect-free planner, NOT live GPS routing,
 * not a dispatch confirmation, not proof that an order exists in Module 1.
 */
export const TALA_DISPATCH_ENGINE_VERSION='1.0.0-lab';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone=/^[a-z0-9][a-z0-9_-]{1,63}$/;
const FRESHNESS_MS=120_000;
type StageName='TRIGGER'|'AVAILABILITY'|'LOAD'|'ATOMIC_ASSIGNMENT';
type StageOutcome='PASS'|'BLOCKED'|'PENDING';
export type TalaDispatchStage=Readonly<{
  name:StageName;
  outcome:StageOutcome;
  remaining:number;
}>;
export type TalaDispatchEvaluation=Readonly<{
  engine:'TALA Dispatch Engine';
  version:typeof TALA_DISPATCH_ENGINE_VERSION;
  orderId:string;
  decision:'PROPOSE'|'NOT_ELIGIBLE'|'NO_AVAILABLE_COURIER';
  reason:'ORDER_NOT_READY'|'NO_ONLINE_COURIER'|'NO_CAPACITY'|'CANDIDATE_REQUIRES_DB_COMMIT';
  courierId?:string;
  stages:readonly TalaDispatchStage[];
}>;
const stage=(name:StageName,outcome:StageOutcome,remaining:number):TalaDispatchStage=>
  ({name,outcome,remaining});

/** This checks workflow eligibility, never existence or authorization. */
export function isDispatchTriggerReady(request:DeliveryAssignmentRequest):boolean{
  return request.fulfillment==='delivery'&&request.orderStatus==='ready';
}
/**
 * The rule is deliberately unchanged from the proven LAB1 policy:
 * fewer active jobs wins, then UUID ascending for a deterministic tie.
 * DB admission must still be authoritative for concurrency/capacity.
 */
export function evaluateTalaDispatch(
  request:DeliveryAssignmentRequest,
  couriers:readonly CourierCapacity[],
  nowMs:number
):TalaDispatchEvaluation{
  if(!request||typeof request.orderId!=='string'||!uuid.test(request.orderId)
    ||typeof request.restaurantId!=='string'||!uuid.test(request.restaurantId)
    ||typeof request.deliveryZone!=='string'||!zone.test(request.deliveryZone)
    ||!Array.isArray(couriers)||couriers.length>500
    ||!Number.isSafeInteger(nowMs)||nowMs<1)
    throw Error('TALA_DISPATCH_INPUT_INVALID');

  const orderId=request.orderId.toLowerCase();
  if(!isDispatchTriggerReady(request)){
    return {engine:'TALA Dispatch Engine',version:TALA_DISPATCH_ENGINE_VERSION,
      orderId,decision:'NOT_ELIGIBLE',reason:'ORDER_NOT_READY',
      stages:[stage('TRIGGER','BLOCKED',0)]};
  }
  const available=couriers.filter(c=>
    c!=null&&typeof c.courierId==='string'&&uuid.test(c.courierId)
    &&c.approved===true&&c.online===true
    &&Array.isArray(c.serviceZones)
    &&c.serviceZones.includes(request.deliveryZone)
    &&Number.isSafeInteger(c.lastSeenAtMs)
    &&c.lastSeenAtMs<=nowMs&&nowMs-c.lastSeenAtMs<=FRESHNESS_MS
  );
  const stages:TalaDispatchStage[]=[stage('TRIGGER','PASS',couriers.length),
    stage('AVAILABILITY',available.length?'PASS':'BLOCKED',available.length)];
  if(!available.length){
    return {engine:'TALA Dispatch Engine',version:TALA_DISPATCH_ENGINE_VERSION,
      orderId,decision:'NO_AVAILABLE_COURIER',reason:'NO_ONLINE_COURIER',stages};
  }
  const ranked=available.filter(c=>
    Number.isSafeInteger(c.activeDeliveries)&&c.activeDeliveries>=0
    &&Number.isSafeInteger(c.maxConcurrentDeliveries)
    &&c.maxConcurrentDeliveries>=1
    &&c.activeDeliveries<c.maxConcurrentDeliveries
  ).sort((a,b)=>a.activeDeliveries-b.activeDeliveries
    ||a.courierId.toLowerCase().localeCompare(b.courierId.toLowerCase()));
  stages.push(stage('LOAD',ranked.length?'PASS':'BLOCKED',ranked.length));
  if(!ranked.length){
    return {engine:'TALA Dispatch Engine',version:TALA_DISPATCH_ENGINE_VERSION,
      orderId,decision:'NO_AVAILABLE_COURIER',reason:'NO_CAPACITY',stages};
  }
  // A read-only proposal is never an assignment or reservation.
  stages.push(stage('ATOMIC_ASSIGNMENT','PENDING',1));
  return {engine:'TALA Dispatch Engine',version:TALA_DISPATCH_ENGINE_VERSION,
    orderId,decision:'PROPOSE',reason:'CANDIDATE_REQUIRES_DB_COMMIT',
    courierId:ranked[0]!.courierId.toLowerCase(),stages};
}
