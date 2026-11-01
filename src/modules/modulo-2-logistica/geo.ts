/** v2 LAB: spherical straight-line distance only, not road distance or ETA. */
export type GeoPoint=Readonly<{latitude:number;longitude:number}>;
export type GeoCourierCandidate=Readonly<{
 courierId:string;distanceMeters:number;activeDeliveries:number;
 remainingCapacity:number;positionAgeSeconds:number;
}>;
export const TALA_GEO_VERSION='2.0.0-lab';
export function validGeoPoint(value:unknown):value is GeoPoint {
 if(value===null||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>;
 return typeof v.latitude==='number'&&Number.isFinite(v.latitude)
  &&v.latitude>=-90&&v.latitude<=90
  &&typeof v.longitude==='number'&&Number.isFinite(v.longitude)
  &&v.longitude>=-180&&v.longitude<=180;
}
export function straightLineMeters(from:GeoPoint,to:GeoPoint):number {
 if(!validGeoPoint(from)||!validGeoPoint(to))throw Error('LOGISTICS_GEO_INVALID');
 const r=Math.PI/180,dy=(to.latitude-from.latitude)*r,
   dx=(to.longitude-from.longitude)*r;
 const a=Math.sin(dy/2)**2+
   Math.cos(from.latitude*r)*Math.cos(to.latitude*r)*Math.sin(dx/2)**2;
 return 6371008.8*2*Math.atan2(Math.sqrt(Math.min(1,a)),Math.sqrt(Math.max(0,1-a)));
}
/** Pure proposal: shorter distance first, lighter load second, UUID tie-break. */
export function rankGeoCandidates(
 candidates:readonly GeoCourierCandidate[],maxMeters=20000
):readonly GeoCourierCandidate[]{
 if(!Array.isArray(candidates)||candidates.length>500||!Number.isFinite(maxMeters)
  ||maxMeters<=0||maxMeters>100000)throw Error('LOGISTICS_GEO_RANK_INVALID');
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 for(const c of candidates){
  if(!c||typeof c.courierId!=='string'||!uuid.test(c.courierId)
   ||!Number.isFinite(c.distanceMeters)||c.distanceMeters<0
   ||!Number.isSafeInteger(c.activeDeliveries)||c.activeDeliveries<0
   ||!Number.isSafeInteger(c.remainingCapacity)||c.remainingCapacity<1
   ||!Number.isFinite(c.positionAgeSeconds)||c.positionAgeSeconds<0
   ||c.positionAgeSeconds>120)throw Error('LOGISTICS_GEO_CANDIDATE_INVALID');
 }
 return candidates.filter(c=>c.distanceMeters<=maxMeters).sort(
  (a,b)=>a.distanceMeters-b.distanceMeters
   ||a.activeDeliveries-b.activeDeliveries
   ||a.courierId.toLowerCase().localeCompare(b.courierId.toLowerCase())
 );
}
