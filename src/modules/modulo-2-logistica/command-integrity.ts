import {createHmac} from 'node:crypto';
import type {GeoPoint} from './geo.ts';

/** Keyed digests protect low-entropy GPS inputs from offline guessing.
 * No secret => fail closed; no hardcoded production fallback. */
function sha256(values:readonly (string|number)[]):string{
  const key=process.env.TALA_DISPATCH_HMAC_KEY;
  if(typeof key!=='string'||Buffer.byteLength(key,'utf8')<32)
    throw Error('LOGISTICS_HMAC_KEY_REQUIRED');
  return createHmac('sha256',key).update(JSON.stringify(values)).digest('hex');
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
