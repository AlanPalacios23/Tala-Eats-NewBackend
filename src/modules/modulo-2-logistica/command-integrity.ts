import {createHash} from 'node:crypto';
import type {GeoPoint} from './geo.ts';

/** Stable request identity: same command key cannot be replayed with
 * different order, restaurant, zone, pickup or radius. No coordinates
 * are emitted to dispatch events; only the SHA-256 digest is persisted. */
function sha256(values:readonly (string|number)[]):string{
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
export function reserveFingerprint(orderId:string,restaurantId:string,
  deliveryZone:string,method:'capacity'|'proximity',
  restaurant?:GeoPoint,maxDistanceMeters?:number):string{
  return sha256(['tala.dispatch.reserve.v2',orderId.toLowerCase(),
    restaurantId.toLowerCase(),deliveryZone,method,
    restaurant?.latitude??'',restaurant?.longitude??'',
    maxDistanceMeters??'']);
}
export function rerouteFingerprint(orderId:string,expectedVersion:string,
  restaurant:GeoPoint,maxDistanceMeters:number):string{
  return sha256(['tala.dispatch.reroute.v2',orderId.toLowerCase(),
    expectedVersion,restaurant.latitude,restaurant.longitude,maxDistanceMeters]);
}
export function finalizeFingerprint(orderId:string,version:string,
  target:'released'|'completed'):string{
  return sha256(['tala.dispatch.finalize.v2',orderId.toLowerCase(),version,target]);
}
