/** M7 independent, operator-configured circular coverage. Never a delivery quote. */
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {LocationError,uuid,operator,point,city,integer,slug,textField,
  member,digest,distanceMeters,type Actor,type Point} from './domain.js';
import {tx,claim,complete,audit} from './db.js';

type Status='draft'|'active'|'disabled';
type Row={id:string,slug:string,name:string,city:string,
 center_lat:number,center_lon:number,radius_m:number,status:Status,version:number};
export async function createZone(pool:Pool,actor:Actor,input:{
 operationId:string,slug:string,name:string,city:string,center:Point,radiusMeters:number
}){
 const admin=operator(actor),op=uuid(input.operationId),key=slug(input.slug),
  name=textField(input.name,2,100),locality=city(input.city),
  center=point(input.center),radius=integer(input.radiusMeters,100,50000,'M7_RADIUS_INVALID');
 const fingerprint=digest({key,name,locality,center,radius});
 return tx(pool,async c=>{
  const previous=await claim(c,admin,op,'zone.create',fingerprint);
  if(previous)return Object.freeze({id:previous,replayed:true});
  const id=randomUUID();
  const duplicate=await c.query('SELECT id FROM tala_locations_v2.coverage_zones WHERE slug=$1',[key]);
  if(duplicate.rowCount)throw new LocationError('M7_ZONE_EXISTS');
  try{
   await c.query('INSERT INTO tala_locations_v2.coverage_zones '+
    '(id,slug,name,city,center_lat,center_lon,radius_m) '+
    'VALUES($1::uuid,$2,$3,$4,$5,$6,$7)',
    [id,key,name,locality,center.latitude,center.longitude,radius]);
  }catch(e){
   if((e as {code?:string}).code==='23505')throw new LocationError('M7_ZONE_EXISTS');
   throw e;
  }
  await audit(c,admin,'zone.create',id);await complete(c,admin,op,id);
  return Object.freeze({id,replayed:false});
 });
}
export async function updateZone(pool:Pool,actor:Actor,input:{
 zoneId:string,expectedVersion:number,name?:string,center?:Point,
 radiusMeters?:number,status?:Status
}){
 const admin=operator(actor),id=uuid(input.zoneId),
  version=integer(input.expectedVersion,1,2147483646,'M7_VERSION_INVALID');
 if([input.name,input.center,input.radiusMeters,input.status].every(v=>v===undefined))
  throw new LocationError('M7_REQUEST_INVALID');
 const name=input.name===undefined?null:textField(input.name,2,100),
  center=input.center===undefined?null:point(input.center),
  radius=input.radiusMeters===undefined?null:integer(input.radiusMeters,100,50000,'M7_RADIUS_INVALID'),
  status=input.status===undefined?null:member(input.status,['draft','active','disabled'] as const,
    'M7_ZONE_STATUS_INVALID');
 return tx(pool,async c=>{
  const changed=await c.query<{version:number}>(
   'UPDATE tala_locations_v2.coverage_zones SET '+
   'name=COALESCE($3,name),center_lat=COALESCE($4,center_lat),'+
   'center_lon=COALESCE($5,center_lon),radius_m=COALESCE($6,radius_m),'+
   'status=COALESCE($7,status),version=version+1,updated_at=clock_timestamp() '+
   'WHERE id=$1::uuid AND version=$2 RETURNING version',
   [id,version,name,center?.latitude??null,center?.longitude??null,radius,status]);
  if(!changed.rows[0])throw new LocationError('M7_VERSION_CONFLICT');
  await audit(c,admin,'zone.update',id);
  return Object.freeze({id,version:changed.rows[0].version});
 });
}
export async function listZones(pool:Pool,actor:Actor){
 operator(actor);
 return tx(pool,async c=>{
  const zones=await c.query<Row>('SELECT id,slug,name,city,center_lat::float8,'+
    'center_lon::float8,radius_m,status,version FROM tala_locations_v2.coverage_zones '+
    'ORDER BY city,slug LIMIT 500');
  return Object.freeze(zones.rows);
 },true);
}
/** Approximate circular membership, explicitly scoped to one named municipality.
 * Does not decide shipping price, courier serviceability or actual delivery ETA.
 * The caller must choose the city; do not guess it from GPS coordinates.
 */
export async function checkCoverage(pool:Pool,input:{city:string,point:Point}){
 const locality=city(input.city),where=point(input.point);
 return tx(pool,async c=>{
  const zones=await c.query<Row>('SELECT id,slug,name,city,center_lat::float8,'+
   'center_lon::float8,radius_m,status,version FROM tala_locations_v2.coverage_zones '+
   "WHERE city=$1 AND status='active' ORDER BY slug LIMIT 500",[locality]);
  const matches=zones.rows.map(z=>({
   zoneId:z.id,zoneName:z.name,city:z.city,
   distanceMeters:Math.round(distanceMeters(where,{
    latitude:z.center_lat,longitude:z.center_lon})),
   radiusMeters:z.radius_m
  })).filter(z=>z.distanceMeters<=z.radiusMeters)
   .sort((a,b)=>a.distanceMeters-b.distanceMeters||a.zoneId.localeCompare(b.zoneId));
  return Object.freeze({city:locality,covered:matches.length>0,
   // Zone identity and distance are not street address or PII.
   zones:Object.freeze(matches.slice(0,20)),
   model:'approximate_circle_v1' as const});
 },true);
}
