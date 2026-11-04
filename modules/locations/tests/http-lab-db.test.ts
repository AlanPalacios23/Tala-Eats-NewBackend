import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {PrivateLocationCipher} from '../src/crypto.js';
import {createLocationsLabHttpServer} from '../src/http-lab.js';
import {LocationError} from '../src/domain.js';
const url=process.env.LOCATIONS_CI_URL??'';
const enabled=/\/tala_locations_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID(),geo={latitude:20.6534,longitude:-103.7042};
test('M7 HTTP LAB: host identity, no privilege injection, redacted places and ephemeral consent',
 {skip:!enabled,timeout:80000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12}),cipher=
  new PrivateLocationCipher(randomBytes(32));
 const owner=id(),other=id(),admin=id();
 const tok='owner-'+id(),oth='other-'+id(),adm='admin-'+id();
 const server=createLocationsLabHttpServer({pool,cipher,
  authenticate:async req=>req.headers.authorization==='Bearer '+tok?
   {actorId:owner}:req.headers.authorization==='Bearer '+oth?
   {actorId:other}:req.headers.authorization==='Bearer '+adm?
   {actorId:admin,canManageZones:true}:null});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 async function call(method:string,path:string,data?:unknown,token?:string){
  const r=await fetch(base+path,{method,headers:{
    ...(data!==undefined?{'content-type':'application/json'}:{}),
    ...(token?{authorization:'Bearer '+token}:{})
  },...(data!==undefined?{body:JSON.stringify(data)}:{})});
  return {status:r.status,body:await r.json() as Record<string,unknown>,
   cache:r.headers.get('cache-control'),cors:r.headers.get('access-control-allow-origin')};
 }
 try{
  assert.equal((await call('GET','/v1/locations/health')).status,200);
  assert.equal((await call('GET','/v1/locations/places')).status,401);
  assert.equal((await call('GET','/v1/locations/zones',undefined,tok)).status,403);
  const noRole=await call('POST','/v1/locations/zones',{
   operationId:id(),slug:'hack-'+id().slice(0,8),name:'Hack',
   city:'tala',center:geo,radiusMeters:1000,canManageZones:true
  },tok);
  assert.equal(noRole.status,400);
  const zone=await call('POST','/v1/locations/zones',{
   operationId:id(),slug:'m7-http-'+id().slice(0,8),name:'Cobertura Tala',
   city:'tala',center:geo,radiusMeters:1500
  },adm);
  assert.equal(zone.status,201);
  const zoneId=String(zone.body.id);
  assert.equal((await call('GET','/v1/locations/coverage?city=tala&latitude='+
   geo.latitude+'&longitude='+geo.longitude,undefined,tok)).body.covered,false);
  assert.equal((await call('PATCH','/v1/locations/zones/'+zoneId,{
   expectedVersion:1,status:'active'},adm)).status,200);
  const coverage=await call('GET','/v1/locations/coverage?city=tala&latitude='+
   geo.latitude+'&longitude='+geo.longitude,undefined,tok);
  assert.equal(coverage.status,200);
  assert.equal(coverage.body.covered,true);
  assert.equal(coverage.cache,'private, no-store');
  assert.equal(coverage.cors,null);
  assert.equal((await call('GET','/v1/locations/coverage?city=tala&latitude=999&longitude=0',
   undefined,tok)).status,400);
  const p=await call('POST','/v1/locations/places',{
   operationId:id(),data:{label:'Casa',addressLine:'Calle privada 7, Tala',
    city:'tala',point:geo,postalCode:'45300',reference:'Casa azul'},
   isDefault:true
  },tok);
  assert.equal(p.status,201);
  const placeId=String(p.body.id);
  const listing=await call('GET','/v1/locations/places',undefined,tok);
  assert.equal((listing.body.places as Array<{data:{addressLine:string}}>)[0]!
   .data.addressLine,'Calle privada 7, Tala');
  assert.equal((await call('GET','/v1/locations/places',undefined,oth)).body.places instanceof Array,true);
  assert.equal(((await call('GET','/v1/locations/places',undefined,oth)).body.places
   as unknown[]).length,0);
  assert.equal((await call('PATCH','/v1/locations/places/'+placeId,{
   expectedVersion:1,patch:{addressLine:'Calle robada'}},oth)).status,404);
  const patch=await call('PATCH','/v1/locations/places/'+placeId,{
   expectedVersion:1,patch:{reference:'Otra puerta'}},tok);
  assert.equal(patch.status,200);
  assert.equal((await call('DELETE','/v1/locations/places/'+placeId,
   {expectedVersion:1},tok)).status,409);
  assert.equal((await call('DELETE','/v1/locations/places/'+placeId,
   {expectedVersion:2},tok)).status,200);
  assert.equal((await call('POST','/v1/locations/snapshot',{
   purpose:'foreground',point:geo,accuracyMeters:6,consent:false},tok)).status,400);
  assert.equal((await call('POST','/v1/locations/snapshot',{
   purpose:'foreground',point:geo,accuracyMeters:6,consent:true,actorId:other},tok)).status,400);
  assert.equal((await call('POST','/v1/locations/snapshot',{
   purpose:'foreground',point:geo,accuracyMeters:6,consent:true},tok)).status,200);
  const snapshot=await call('GET','/v1/locations/snapshot/foreground',undefined,tok);
  assert.equal((snapshot.body.snapshot as {point:{latitude:number}}).point.latitude,geo.latitude);
  assert.equal((await call('GET','/v1/locations/snapshot/foreground',undefined,oth))
   .body.snapshot,null);
  assert.equal((await call('DELETE','/v1/locations/snapshot/foreground',{},tok))
   .status,200);
  assert.equal((await call('GET','/v1/locations/snapshot/foreground',undefined,tok))
   .body.snapshot,null);
 }finally{
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  await pool.end();
 }
});
test('M7 HTTP LAB rejects startup in production mode',()=>{
 const before=process.env.NODE_ENV;
 try{
  process.env.NODE_ENV='production';
  const fake=new pg.Pool({connectionString:'postgresql://invalid'});
  const cipher=new PrivateLocationCipher(randomBytes(32));
  assert.throws(()=>createLocationsLabHttpServer({
   pool:fake,cipher,authenticate:async()=>null
  }),e=>e instanceof LocationError&&e.code==='M7_LAB_HTTP_DISABLED');
  void fake.end();
 }finally{
  if(before===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=before;
 }
});
