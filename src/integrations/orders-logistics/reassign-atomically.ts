/** Single trusted entry point for LAB cross-module rerouting.
 * Binds real Orders verification AND Orders update to the same Logistics
 * PoolClient/transaction. Not registered as an HTTP endpoint.
 * Any future route must authenticate/authorize the caller separately.
 */
import type {Pool} from 'pg';
import type {GeoPoint} from '../../modules/modulo-2-logistica/geo.ts';
import {reassignUnavailableDelivery,type RerouteResult}
  from '../../modules/modulo-2-logistica/geo-reroute-service.ts';
import {verifyOrdersPrePickup} from './verify-pre-pickup.ts';
import {commitOrdersReassignment} from './commit-reassignment.ts';

export async function reassignOrderDispatchAtomic(
  pool:Pool,orderId:string,expectedLogisticsVersion:string,
  commandKey:string,restaurant:GeoPoint,maxDistanceMeters=20000
):Promise<RerouteResult>{
  return reassignUnavailableDelivery(pool,orderId,expectedLogisticsVersion,
    commandKey,restaurant,maxDistanceMeters,
    verifyOrdersPrePickup,commitOrdersReassignment);
}
