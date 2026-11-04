import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {PrivateLocationCipher} from '../src/crypto.js';
import {LocationError} from '../src/domain.js';
import {createZone,updateZone} from '../src/zones.js';
import {createPolygonZone,updatePolygonZone,listPolygonZones,
 checkCoverageV2} from '../src/polygon-zones.js';
import {createLocationsLabHttpServer} from '../src/http-lab.js';
const url=process.env.LOCATIONS_CI_URL??'';
const enabled=url.includes('/tala_locations_v2_test');
const id=()=>randomUUID();
const p=(latitude:number,longitude:number)=>({latitude,longitude});
const square=[p(20,-103),p(20,-102.999),p(20.001,-102.999),p(20.001,-103)];
const fail=(task:()=>Promise<unknown>,code:string)=>
 assert.rejects(task,e=>e instanceof LocationError&&e.code===code);

test('M7 LAB2 polygon administration, default draft, privacy, CAS, retry and coverage v2',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 const admin={actorId:id(),canManageZones:true},guest={actorId:id()};
 try{
  const req={operationId:id(),slug:'poly-'+id().slice(0,8),
   name:'Polígono de prueba',city:'tala',vertices:square};
  await fail(()=>createPolygonZone(pool,guest,req),'M7_FORBIDDEN');
  const created=await createPolygonZone(pool,admin,req);
  assert.equal((await createPolygonZone(pool,admin,req)).replayed,true);
  assert.equal((await createPolygonZone(pool,admin,req)).id,created.id);
  await fail(()=>createPolygonZone(pool,admin,{...req,name:'Otra geometría'}),
    'M7_IDEMPOTENCY_CONFLICT');
  await fail(()=>createPolygonZone(pool,admin,{...req,operationId:id()}),
    'M7_POLYGON_EXISTS');
  const here=p(20.0005,-102.9995);
  assert.equal((await checkCoverageV2(pool,{city:'tala',point:here})).zones
   .some(x=>x.zoneId===created.id),false);
  const enabledZone=await updatePolygonZone(pool,admin,{
   zoneId:created.id,expectedVersion:1,status:'active'});
  assert.equal(enabledZone.version,2);
  await fail(()=>updatePolygonZone(pool,admin,{
   zoneId:created.id,expectedVersion:1,name:'Version obsoleta'}),
   'M7_VERSION_CONFLICT');
  await fail(()=>updatePolygonZone(pool,guest,{
   zoneId:created.id,expectedVersion:2,status:'disabled'}),
   'M7_FORBIDDEN');
  const inside=await checkCoverageV2(pool,{city:'tala',point:here});
  assert.equal(inside.covered,true);
  assert.equal(inside.operationallyVerified,false);
  assert.equal(inside.model,'operator_defined_geofences_v2');
  assert.ok(inside.zones.some(x=>x.zoneId===created.id&&x.kind==='polygon'));
  assert.equal(inside.zones.some(x=>Object.hasOwn(x,'vertices')),false);
  assert.equal((await checkCoverageV2(pool,{city:'tala',point:square[0]!})).zones
   .some(x=>x.zoneId===created.id),true);
  assert.equal((await checkCoverageV2(pool,{city:'tala',point:p(20.005,-103)})).zones
   .some(x=>x.zoneId===created.id),false);
  assert.equal((await checkCoverageV2(pool,{city:'ameca',point:here})).zones
   .some(x=>x.zoneId===created.id),false);
  await fail(()=>listPolygonZones(pool,guest),'M7_FORBIDDEN');
  const managed=await listPolygonZones(pool,admin);
  assert.ok(managed.some(x=>x.id===created.id&&x.vertices.length===4));
  const circle=await createZone(pool,admin,{operationId:id(),
   slug:'circle-'+id().slice(0,8),name:'Círculo de laboratorio',
   city:'tala',center:here,radiusMeters:500});
  await updateZone(pool,admin,{zoneId:circle.id,expectedVersion:1,
   status:'active'});
  const mixed=await checkCoverageV2(pool,{city:'tala',point:here});
  assert.ok(mixed.zones.some(x=>x.zoneId===created.id&&x.kind==='polygon'));
  assert.ok(mixed.zones.some(x=>x.zoneId===circle.id&&x.kind==='circle'));
  await updatePolygonZone(pool,admin,{zoneId:created.id,expectedVersion:2,
   status:'disabled'});
  assert.equal((await checkCoverageV2(pool,{city:'tala',point:here})).zones
   .some(x=>x.zoneId===created.id),false);
  await updateZone(pool,admin,{zoneId:circle.id,expectedVersion:2,
   status:'disabled'});
  const audit=await pool.query<{n:number}>(
   "SELECT count(*)::int AS n FROM tala_locations_v2.audit "+
   "WHERE entity_id=$1::uuid AND action LIKE 'polygon.%'",[created.id]);
  assert.equal(audit.rows[0]!.n,3);
  await assert.rejects(pool.query('DELETE FROM tala_locations_v2.audit '+
   'WHERE entity_id=$1::uuid',[created.id]),/IMMUTABLE/);
 }finally{await pool.end();}
});

test('M7 LAB2 HTTP polygon and coverage endpoints require host roles, no body role injection',
 {skip:!enabled,timeout:70000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8});
 const cipher=new PrivateLocationCipher(randomBytes(32)),
   admin={actorId:id(),canManageZones:true},user={actorId:id()},
   adm='Bearer adm-'+id(),usr='Bearer usr-'+id();
 const server=createLocationsLabHttpServer({pool,cipher,
  authenticate:async req=>req.headers.authorization===adm?admin:
    req.headers.authorization===usr?user:null});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 async function call(method:string,path:string,token:string,data?:unknown){
  const res=await fetch(base+path,{method,headers:{
   authorization:token,...(data===undefined?{}:{'content-type':'application/json'})
  },...(data===undefined?{}:{body:JSON.stringify(data)})});
  return {status:res.status,body:await res.json() as Record<string,any>,
   cache:res.headers.get('cache-control')};
 }
 try{
  const req={operationId:id(),slug:'http-poly-'+id().slice(0,8),
   name:'Área de prueba',city:'tala',vertices:square};
  assert.equal((await call('GET','/v1/locations/polygons',usr)).status,403);
  assert.equal((await call('POST','/v1/locations/polygons',usr,
   {...req,canManageZones:true})).status,400);
  const created=await call('POST','/v1/locations/polygons',adm,req);
  assert.equal(created.status,201);
  const zoneId=String(created.body.id);
  const q='/v1/locations/coverage/v2?city=tala&latitude=20.0005&longitude=-102.9995';
  assert.equal((await call('GET',q,usr)).body.covered,false);
  assert.equal((await call('PATCH','/v1/locations/polygons/'+zoneId,adm,{
   expectedVersion:1,status:'active'})).status,200);
  const covered=await call('GET',q,usr);
  assert.equal(covered.status,200);
  assert.equal(covered.body.covered,true);
  assert.equal(covered.cache,'private, no-store');
  assert.ok((covered.body.zones as Array<{zoneId:string}>).some(x=>x.zoneId===zoneId));
  assert.equal((await call('GET',q.replace('tala','guadalajara'),usr)).status,400);
  assert.equal((await call('GET',q+'&actorId='+user.actorId,usr)).status,400);
  assert.equal((await call('PATCH','/v1/locations/polygons/'+zoneId,usr,{
   expectedVersion:2,status:'disabled'})).status,403);
  assert.equal((await call('PATCH','/v1/locations/polygons/'+zoneId,adm,{
   expectedVersion:1,status:'disabled'})).status,409);
 }finally{
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  await pool.end();
 }
});
