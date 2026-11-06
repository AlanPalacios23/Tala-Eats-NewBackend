import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {LocationError} from '../src/domain.js';
import {PrivateLocationCipher} from '../src/crypto.js';
import {createPlace,listPlaces} from '../src/places.js';
import {putLocationSnapshot,getLocationSnapshot} from '../src/snapshots.js';
import {eraseMyLocationData} from '../src/privacy.js';
import {createLocationsLabHttpServer} from '../src/http-lab.js';

const url=process.env.LOCATIONS_CI_URL??'';
const enabled=url.includes('/tala_locations_v2_test');
const id=()=>randomUUID();
const point={latitude:20.6534,longitude:-103.7042};
const data={label:'Mi casa',addressLine:'Calle de prueba 77, Tala',
 city:'tala',point,postalCode:'45300',reference:'Entrada principal'};
const fail=(task:()=>Promise<unknown>,code:string)=>
 assert.rejects(task,e=>e instanceof LocationError&&e.code===code);

test('M7 LAB3 GPS publication requires explicit request consent AND a trusted host grant',
 {skip:!enabled,timeout:65000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8}),
   cipher=new PrivateLocationCipher(randomBytes(32));
 const actor={actorId:id()},foreground={actorId:actor.actorId,
   locationConsentPurposes:['foreground'] as const};
 try{
  await fail(()=>putLocationSnapshot(pool,cipher,actor,{purpose:'foreground',
   point,accuracyMeters:10,consent:true}),'M7_LOCATION_GRANT_REQUIRED');
  await fail(()=>putLocationSnapshot(pool,cipher,foreground,{
   purpose:'active_delivery',point,accuracyMeters:10,consent:true}),
   'M7_LOCATION_GRANT_REQUIRED');
  await fail(()=>putLocationSnapshot(pool,cipher,foreground,{purpose:'foreground',
   point,accuracyMeters:10,consent:false}),'M7_CONSENT_REQUIRED');
  assert.equal(await getLocationSnapshot(pool,cipher,actor,'foreground'),null);
  const published=await putLocationSnapshot(pool,cipher,foreground,
   {purpose:'foreground',point,accuracyMeters:10,consent:true});
  assert.ok(published.expiresAt.getTime()>Date.now());
  assert.deepEqual((await getLocationSnapshot(pool,cipher,actor,'foreground'))!.point,
   point);
  const delivery={actorId:actor.actorId,
   locationConsentPurposes:['active_delivery'] as const};
  await putLocationSnapshot(pool,cipher,delivery,{
   purpose:'active_delivery',point,accuracyMeters:20,consent:true});
  assert.equal((await getLocationSnapshot(pool,cipher,delivery,'active_delivery'))!
   .accuracyMeters,20);
 }finally{await pool.end();}
});

test('M7 LAB3 owner erasure is atomic, owner-isolated and removes place fingerprint receipts',
 {skip:!enabled,timeout:75000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8}),
   cipher=new PrivateLocationCipher(randomBytes(32));
 const owner={actorId:id(),locationConsentPurposes:['foreground'] as const},
   other={actorId:id(),locationConsentPurposes:['foreground'] as const};
 try{
  const op=id();
  const first=await createPlace(pool,cipher,owner,{operationId:op,
   data,isDefault:true});
  await createPlace(pool,cipher,other,{operationId:id(),
   data,isDefault:true});
  await putLocationSnapshot(pool,cipher,owner,{
   purpose:'foreground',point,accuracyMeters:8,consent:true});
  await putLocationSnapshot(pool,cipher,other,{
   purpose:'foreground',point,accuracyMeters:12,consent:true});
  const erased=await eraseMyLocationData(pool,owner);
  assert.deepEqual(erased,{erased:true,placesDeleted:1,snapshotsDeleted:1,
   receiptsDeleted:1});
  assert.equal((await listPlaces(pool,cipher,owner)).length,0);
  assert.equal(await getLocationSnapshot(pool,cipher,owner,'foreground'),null);
  assert.equal((await listPlaces(pool,cipher,other)).length,1);
  assert.ok(await getLocationSnapshot(pool,cipher,other,'foreground'));
  const row=await pool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_locations_v2.saved_places '+
   'WHERE owner_id=$1::uuid',[owner.actorId]);
  assert.equal(row.rows[0]!.n,0);
  const receipt=await pool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_locations_v2.idempotency_receipts '+
   'WHERE actor_id=$1::uuid AND operation_id=$2::uuid',[owner.actorId,op]);
  assert.equal(receipt.rows[0]!.n,0);
  const audit=await pool.query<{action:string}>(
   "SELECT action FROM tala_locations_v2.audit WHERE actor_id=$1::uuid "+
   "AND action='location.erase_all'",[owner.actorId]);
  assert.equal(audit.rows.length,1);
  assert.equal((await eraseMyLocationData(pool,owner)).placesDeleted,0);
  // A request retried after data erasure is a new user operation because
  // the idempotency receipt was intentionally erased with the private data.
  const again=await createPlace(pool,cipher,owner,{operationId:op,
   data,isDefault:true});
  assert.notEqual(again.id,first.id);
 }finally{await pool.end();}
});

test('M7 LAB3 HTTP refuses unverified GPS grants and supports authenticated own erasure',
 {skip:!enabled,timeout:70000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8}),
   cipher=new PrivateLocationCipher(randomBytes(32));
 const first={actorId:id(),locationConsentPurposes:['foreground'] as const},
   blocked={actorId:id()};
 const trusted='Bearer trusted-'+id(),ungranted='Bearer no-grant-'+id();
 const server=createLocationsLabHttpServer({pool,cipher,
  authenticate:async req=>req.headers.authorization===trusted?first:
   req.headers.authorization===ungranted?blocked:null});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 async function call(method:string,path:string,token:string,data?:unknown){
  const res=await fetch(base+path,{method,headers:{
   authorization:token,...(data===undefined?{}:{'content-type':'application/json'})
  },...(data===undefined?{}:{body:JSON.stringify(data)})});
  return {status:res.status,body:await res.json() as Record<string,any>};
 }
 try{
  const location={purpose:'foreground',point,accuracyMeters:8,consent:true};
  assert.equal((await call('POST','/v1/locations/snapshot',
   ungranted,location)).status,400);
  assert.equal((await call('POST','/v1/locations/snapshot',trusted,{
   ...location,purpose:'active_delivery'})).status,400);
  assert.equal((await call('POST','/v1/locations/snapshot',trusted,location)).status,200);
  assert.equal((await call('POST','/v1/locations/places',trusted,{
   operationId:id(),data,isDefault:true})).status,201);
  const noAuth=await call('DELETE','/v1/locations/privacy/data','Bearer invalid',{});
  assert.equal(noAuth.status,401);
  const noBody=await call('DELETE','/v1/locations/privacy/data',trusted);
  assert.equal(noBody.status,415);
  const denied=await call('DELETE','/v1/locations/privacy/data',trusted,
   {actorId:blocked.actorId});
  assert.equal(denied.status,400);
  const erased=await call('DELETE','/v1/locations/privacy/data',trusted,{});
  assert.equal(erased.status,200);
  assert.equal(erased.body.erased,true);
  assert.equal(erased.body.placesDeleted,1);
  assert.equal(erased.body.snapshotsDeleted,1);
  assert.equal((await call('GET','/v1/locations/places',trusted)).body.places.length,0);
  assert.equal((await call('GET','/v1/locations/snapshot/foreground',
   trusted)).body.snapshot,null);
 }finally{
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  await pool.end();
 }
});
