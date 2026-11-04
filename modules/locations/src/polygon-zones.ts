/** M7 LAB2 operator-managed polygon zones and geometry-only combined coverage.
 * No authenticated user PII, dispatch, routing, financial or order operations.
 */
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {LocationError,city,slug,uuid,operator,point,integer,textField,member,
  digest,distanceMeters,type Actor,type Point} from './domain.js';
import {tx,claim,complete,audit} from './db.js';
import {validatePolygon,withinPolygon,type Polygon} from './polygon.js';
type Status='draft'|'active'|'disabled';
type PolygonRow={id:string,slug:string,name:string,city:string,
 vertices:unknown,status:Status,version:number};
type CircleRow={id:string,name:string,city:string,center_lat:number,
 center_lon:number,radius_m:number};

export async function createPolygonZone(pool:Pool,actor:Actor,input:{
 operationId:string,slug:string,name:string,city:string,vertices:Point[]
}){
 const user=operator(actor),op=uuid(input.operationId);
 const key=slug(input.slug),name=textField(input.name,2,100),
   locality=city(input.city),vertices=validatePolygon(input.vertices);
 const fp=digest({key,name,locality,vertices});
 return tx(pool,async c=>{
  const old=await claim(c,user,op,'polygon.create',fp);
  if(old)return Object.freeze({id:old,replayed:true});
  const id=randomUUID();
  try{
   await c.query('INSERT INTO tala_locations_v2.polygon_zones '+
    '(id,slug,name,city,vertices) VALUES($1::uuid,$2,$3,$4,$5::jsonb)',
    [id,key,name,locality,JSON.stringify(vertices)]);
  }catch(e){
   if((e as {code?:string}).code==='23505')
     throw new LocationError('M7_POLYGON_EXISTS');
   throw e;
  }
  await audit(c,user,'polygon.create',id);
  await complete(c,user,op,id);
  return Object.freeze({id,replayed:false});
 });
}
export async function updatePolygonZone(pool:Pool,actor:Actor,input:{
 zoneId:string,expectedVersion:number,
 name?:string,vertices?:Point[],status?:Status
}){
 const user=operator(actor),id=uuid(input.zoneId),
  version=integer(input.expectedVersion,1,2147483646,'M7_VERSION_INVALID');
 if([input.name,input.vertices,input.status].every(v=>v===undefined))
   throw new LocationError('M7_REQUEST_INVALID');
 const name=input.name===undefined?null:textField(input.name,2,100),
  vertices=input.vertices===undefined?null:validatePolygon(input.vertices),
  status=input.status===undefined?null:member(input.status,
   ['draft','active','disabled'] as const,'M7_ZONE_STATUS_INVALID');
 return tx(pool,async c=>{
  const changed=await c.query<{version:number}>(
   'UPDATE tala_locations_v2.polygon_zones SET name=COALESCE($3,name),'+
   'vertices=COALESCE($4::jsonb,vertices),'+
   'status=COALESCE($5,status),version=version+1,'+
   'updated_at=clock_timestamp() '+
   'WHERE id=$1::uuid AND version=$2 RETURNING version',
   [id,version,name,vertices?JSON.stringify(vertices):null,status]);
  if(!changed.rows[0])throw new LocationError('M7_VERSION_CONFLICT');
  await audit(c,user,'polygon.update',id);
  return Object.freeze({id,version:changed.rows[0].version});
 });
}
export async function listPolygonZones(pool:Pool,actor:Actor){
 operator(actor);
 return tx(pool,async c=>{
  const r=await c.query<PolygonRow>(
   'SELECT id,slug,name,city,vertices,status,version '+
   'FROM tala_locations_v2.polygon_zones ORDER BY city,slug LIMIT 500');
  return Object.freeze(r.rows.map(x=>Object.freeze({
   id:x.id,slug:x.slug,name:x.name,city:x.city,
   vertices:validatePolygon(x.vertices),status:x.status,version:x.version
  })));
 },true);
}

/** Combined circle/polygon geometry check: never delivery eligibility or ETA.
 * The caller supplies a city. Geometry is operator-defined and not verified
 * against authoritative municipal borders, street access or real operations.
 */
export async function checkCoverageV2(pool:Pool,input:{city:string,point:Point}){
 const locality=city(input.city),where=point(input.point);
 return tx(pool,async c=>{
  const circles=await c.query<CircleRow>(
   'SELECT id,name,city,center_lat::float8,center_lon::float8,radius_m '+
   'FROM tala_locations_v2.coverage_zones '+
   "WHERE city=$1 AND status='active' ORDER BY id LIMIT 500",[locality]);
  const polygons=await c.query<PolygonRow>(
   'SELECT id,slug,name,city,vertices,status,version '+
   'FROM tala_locations_v2.polygon_zones '+
   "WHERE city=$1 AND status='active' ORDER BY id LIMIT 500",[locality]);
  const result:Array<{
   zoneId:string,zoneName:string,kind:'circle'|'polygon',
   distanceMeters?:number,radiusMeters?:number
  }>=[];
  for(const z of circles.rows){
   const distance=distanceMeters(where,{latitude:z.center_lat,
     longitude:z.center_lon});
   if(distance<=z.radius_m)result.push({
    zoneId:z.id,zoneName:z.name,kind:'circle',
    distanceMeters:Math.round(distance),radiusMeters:z.radius_m
   });
  }
  for(const z of polygons.rows){
   if(withinPolygon(where,validatePolygon(z.vertices)))
    result.push({zoneId:z.id,zoneName:z.name,kind:'polygon'});
  }
  result.sort((a,b)=>a.kind.localeCompare(b.kind)||
   a.zoneId.localeCompare(b.zoneId));
  return Object.freeze({city:locality,covered:result.length>0,
   zones:Object.freeze(result.slice(0,20).map(x=>Object.freeze(x))),
   model:'operator_defined_geofences_v2' as const,
   // Do not suggest a route, ETA, municipality inference, fare or driver.
   operationallyVerified:false as const});
 },true);
}
