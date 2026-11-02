/** TALA Dispatch Engine GEO v2 — internal-only transactional reservation.
 * Requires an authenticated and verified Orders adapter for the request
 * and restaurant coordinate. This function does NOT perform that validation. */
import type {Pool} from 'pg';
import type {DeliveryAssignmentRequest} from './contracts.ts';
import type {GeoPoint} from './geo.ts';
import {reserveDelivery,type DispatchDecision} from './dispatch-service.ts';

export async function reserveNearestDelivery(
  pool:Pool,
  request:DeliveryAssignmentRequest,
  commandKey:string,
  restaurant:GeoPoint,
  maxDistanceMeters=20000
):Promise<DispatchDecision>{
  return reserveDelivery(pool,request,commandKey,
    {restaurant,maxDistanceMeters});
}
