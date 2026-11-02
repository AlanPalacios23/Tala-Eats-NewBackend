/**
 * INTERNAL location layer for LAB; no HTTP route or caller identity adapter.
 * The eventual auth adapter must bind the caller's identity to courierId.
 * Persist only last location: never store tracks or buyer coordinates.
 */
import type {Pool} from 'pg';
import {validGeoPoint,straightLineMeters,rankGeoCandidates,
 type GeoPoint,type GeoCourierCandidate} from './geo.ts';
import {LogisticsError} from './dispatch-service.ts';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone=/^[a-z0-9][a-z0-9_-]{1,63}$/;
function bad(code:string):never{throw new LogisticsError(code);}
export async function recordCourierPosition(
 pool:Pool,courierId:string,point:GeoPoint,accuracyMeters:number
):Promise<void>{
 if(typeof courierId!=='string'||!uuid.test(courierId))bad('LOGISTICS_ID_INVALID');
 if(!validGeoPoint(point)||!Number.isFinite(accuracyMeters)
  ||accuracyMeters<0||accuracyMeters>100)bad('LOGISTICS_GPS_INVALID');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '3000ms'");
  const verified=await client.query<{id:string}>(
   "SELECT id FROM tala_logistics_v2.couriers "+
   "WHERE id=$1::uuid AND approved=true AND online=true "+
   "AND last_seen_at BETWEEN clock_timestamp()-interval '120 seconds' "+
   "AND clock_timestamp() FOR UPDATE",[courierId]
  );
  if(!verified.rows[0])bad('LOGISTICS_GPS_COURIER_UNAVAILABLE');
  await client.query(
   "INSERT INTO tala_logistics_v2.courier_positions "+
   "(courier_id,latitude,longitude,accuracy_m,observed_at) "+
   "VALUES($1::uuid,$2,$3,$4,clock_timestamp()) "+
   "ON CONFLICT(courier_id) DO UPDATE SET "+
   "latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,"+
   "accuracy_m=EXCLUDED.accuracy_m,observed_at=EXCLUDED.observed_at",
   [courierId.toLowerCase(),point.latitude,point.longitude,accuracyMeters]
  );
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}
 finally{client.release();}
}
/** Read-only proximity proposals. Raw driver GPS never leaves this service;
 * the output contains distance, load and age ONLY.
 * Not a reservation; reserveDelivery needs a separate SQL lock/recheck.
 */
export async function listNearbyCouriers(
 pool:Pool,deliveryZone:string,restaurant:GeoPoint,maxMeters=20000
):Promise<readonly GeoCourierCandidate[]>{
 if(typeof deliveryZone!=='string'||!zone.test(deliveryZone)
  ||!validGeoPoint(restaurant)||!Number.isFinite(maxMeters)
  ||maxMeters<=0||maxMeters>100000)bad('LOGISTICS_GEO_QUERY_INVALID');
 const result=await pool.query<{
   id:string;latitude:number;longitude:number;observed_at:Date;
   active_count:string;capacity:number;server_now:Date;
 }>(
  "SELECT c.id,p.latitude,p.longitude,p.observed_at,"+
  "clock_timestamp() AS server_now,c.capacity,"+
  "(SELECT count(*)::text FROM tala_logistics_v2.dispatch_reservations d "+
  " WHERE d.courier_id=c.id AND d.status='reserved') AS active_count "+
  "FROM tala_logistics_v2.couriers c "+
  "JOIN tala_logistics_v2.courier_positions p ON p.courier_id=c.id "+
  "WHERE c.approved AND c.online AND c.zone=$1 "+
  "AND c.last_seen_at BETWEEN clock_timestamp()-interval '120 seconds' "+
  "AND clock_timestamp() "+
  "AND p.observed_at BETWEEN clock_timestamp()-interval '120 seconds' "+
  "AND clock_timestamp() ORDER BY c.id LIMIT 500",
  [deliveryZone]
 );
 const candidates:GeoCourierCandidate[]=[];
 for(const row of result.rows){
  const load=Number(row.active_count);
  const age=(row.server_now.getTime()-row.observed_at.getTime())/1000;
  if(!Number.isSafeInteger(load)||load<0||load>=row.capacity
   ||!Number.isFinite(age)||age<0||age>120)continue;
  candidates.push({
   courierId:row.id,
   distanceMeters:Math.round(straightLineMeters(restaurant,
    {latitude:row.latitude,longitude:row.longitude})),
   activeDeliveries:load,
   remainingCapacity:row.capacity-load,
   positionAgeSeconds:age
  });
 }
 return rankGeoCandidates(candidates,maxMeters);
}
