import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {LocationError} from '../src/domain.js';
import {PrivateLocationCipher} from '../src/crypto.js';
import {createZone,updateZone,listZones,checkCoverage} from '../src/zones.js';
import {createPlace,listPlaces,updatePlace,setDefaultPlace,deletePlace} from '../src/places.js';
import {putLocationSnapshot,getLocationSnapshot,clearLocationSnapshot,
 pruneExpiredSnapshots} from '../src/snapshots.js';
const url=process.env.LOCATIONS_CI_URL??'';
const enabled=/\/tala_locations_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID(),cipher=()=>new PrivateLocationCipher(randomBytes(32));
const fail=(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,
 (e:unknown)=>e instanceof LocationError&&e.code===code);
const tala={latitude:20.6534,longitude:-103.7042};
function info(n:number){return {label:'Casa '+n,addressLine:'Calle Privada '+n+
 ', Tala Jalisco',city:'tala',point:tala,postalCode:'45300',reference:'Porton '+n};}

test('M7 coverage: staff-only zones, no speculative seeds, geographic math, CAS and idempotency',
 {skip:!enabled,timeout:70000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 const admin={actorId:id(),canManageZones:true},user={actorId:id()};
 try{
  assert.equal((await checkCoverage(pool,{city:'tala',point:tala})).covered,false);
  await fail(()=>createZone(pool,user,{operationId:id(),slug:'bad-zone',name:'Zona',
   city:'tala',center:tala,radiusMeters:1500}),'M7_FORBIDDEN');
  const create={operationId:id(),slug:'zona-'+id().slice(0,8),
   name:'Zona Tala piloto',city:'tala',center:tala,radiusMeters:1500};
  const z=await createZone(pool,admin,create);
  assert.equal((await createZone(pool,admin,create)).id,z.id);
  await fail(()=>createZone(pool,admin,{...create,name:'Zona diferente'}),
   'M7_IDEMPOTENCY_CONFLICT');
  await fail(()=>createZone(pool,admin,{...create,operationId:id()}),'M7_ZONE_EXISTS');
  assert.equal((await checkCoverage(pool,{city:'tala',point:tala})).covered,false);
  await updateZone(pool,admin,{zoneId:z.id,expectedVersion:1,status:'active'});
  await fail(()=>updateZone(pool,admin,{zoneId:z.id,expectedVersion:1,
   radiusMeters:2000}),'M7_VERSION_CONFLICT');
  const covered=await checkCoverage(pool,{city:'tala',point:tala});
  assert.equal(covered.covered,true);
  assert.equal(covered.zones[0]!.distanceMeters,0);
  assert.equal(covered.model,'approximate_circle_v1');
  assert.equal((await checkCoverage(pool,{city:'tala',point:{
   latitude:20.8,longitude:-103.7}})).covered,false);
  assert.equal((await checkCoverage(pool,{city:'ameca',point:tala})).covered,false);
  await fail(()=>listZones(pool,user),'M7_FORBIDDEN');
  assert.ok((await listZones(pool,admin)).some(x=>x.id===z.id));
  await updateZone(pool,admin,{zoneId:z.id,expectedVersion:2,status:'disabled'});
  assert.equal((await checkCoverage(pool,{city:'tala',point:tala})).covered,false);
  const a=await pool.query<{n:number}>(
   "SELECT count(*)::int AS n FROM tala_locations_v2.audit WHERE action='zone.update' "+
   'AND entity_id=$1::uuid',[z.id]);
  assert.equal(a.rows[0]!.n,2);
  await assert.rejects(pool.query('DELETE FROM tala_locations_v2.audit '+
   'WHERE entity_id=$1::uuid',[z.id]),/IMMUTABLE/);
 }finally{await pool.end();}
});

test('M7 private encrypted address CRUD: owner isolation, defaults, CAS, redaction and retry',
 {skip:!enabled,timeout:80000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:14}),key=cipher();
 const owner={actorId:id()},outsider={actorId:id()};
 try{
  const req={operationId:id(),data:info(1),isDefault:true};
  const first=await createPlace(pool,key,owner,req);
  assert.equal((await createPlace(pool,key,owner,req)).replayed,true);
  await fail(()=>createPlace(pool,key,owner,{...req,data:info(2)}),
   'M7_IDEMPOTENCY_CONFLICT');
  const secret=await pool.query<{ciphertext:Buffer,nonce:Buffer}>(
   'SELECT ciphertext,nonce FROM tala_locations_v2.saved_places WHERE id=$1::uuid',
   [first.id]);
  assert.equal(secret.rows[0]!.nonce.length,12);
  assert.ok(!secret.rows[0]!.ciphertext.toString('utf8').includes('Privada'));
  assert.equal((await listPlaces(pool,key,outsider)).length,0);
  const second=await createPlace(pool,key,owner,{operationId:id(),
   data:info(2),isDefault:true});
  const places=await listPlaces(pool,key,owner);
  assert.equal(places.filter(x=>x.isDefault).length,1);
  assert.equal(places.find(x=>x.id===second.id)!.isDefault,true);
  const v=places.find(x=>x.id===first.id)!.version;
  const edited=await updatePlace(pool,key,owner,{placeId:first.id,
   expectedVersion:v,patch:{reference:'Edificio 2'}});
  assert.equal(edited.version,v+1);
  assert.equal((await listPlaces(pool,key,owner)).find(x=>x.id===first.id)!
   .data.reference,'Edificio 2');
  await fail(()=>updatePlace(pool,key,owner,{placeId:first.id,
   expectedVersion:v,patch:{label:'Duplicado'}}),'M7_VERSION_CONFLICT');
  await fail(()=>updatePlace(pool,key,outsider,{placeId:first.id,
   expectedVersion:edited.version,patch:{label:'Robo'}}),'M7_PLACE_NOT_FOUND');
  const marked=await setDefaultPlace(pool,owner,{placeId:first.id,
   expectedVersion:edited.version});
  assert.equal(marked.unchanged,false);
  assert.equal((await listPlaces(pool,key,owner)).filter(x=>x.isDefault).length,1);
  const originalCipher=await pool.query<{ciphertext:Buffer}>(
   'SELECT ciphertext FROM tala_locations_v2.saved_places WHERE id=$1::uuid',
   [first.id]);
  await fail(()=>deletePlace(pool,outsider,{placeId:first.id,
   expectedVersion:marked.version}),'M7_VERSION_CONFLICT');
  await deletePlace(pool,owner,{placeId:first.id,expectedVersion:marked.version});
  assert.equal((await listPlaces(pool,key,owner)).length,1);
  const erased=await pool.query<{ciphertext:Buffer,deleted_at:Date}>(
   'SELECT ciphertext,deleted_at FROM tala_locations_v2.saved_places '+
   'WHERE id=$1::uuid',[first.id]);
  assert.ok(erased.rows[0]!.deleted_at);
  assert.notDeepEqual(erased.rows[0]!.ciphertext,originalCipher.rows[0]!.ciphertext);
 }finally{await pool.end();}
});

test('M7 owner-level address cap and concurrent identical publication', 
 {skip:!enabled,timeout:80000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:16}),key=cipher(),
  owner={actorId:id()};
 try{
  const first={operationId:id(),data:info(1)};
  const results=await Promise.all(Array.from({length:8},()=>
   createPlace(pool,key,owner,first)));
  assert.equal(new Set(results.map(x=>x.id)).size,1);
  for(let i=2;i<=15;i++)
   await createPlace(pool,key,owner,{operationId:id(),data:info(i)});
  assert.equal((await listPlaces(pool,key,owner)).length,15);
  await fail(()=>createPlace(pool,key,owner,{operationId:id(),data:info(16)}),
   'M7_PLACE_LIMIT');
  assert.equal((await listPlaces(pool,key,owner)).length,15);
 }finally{await pool.end();}
});

test('M7 opt-in GPS snapshots: own encrypted position, TTL, consent, revocation and purge',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:10}),key=cipher(),
  first={actorId:id()},second={actorId:id()};
 try{
  await fail(()=>putLocationSnapshot(pool,key,first,{purpose:'foreground',
   point:tala,accuracyMeters:4,consent:false}),'M7_CONSENT_REQUIRED');
  await fail(()=>putLocationSnapshot(pool,key,first,{purpose:'foreground',
   point:tala,accuracyMeters:2001,consent:true}),'M7_ACCURACY_INVALID');
  const snap=await putLocationSnapshot(pool,key,first,{purpose:'foreground',
   point:tala,accuracyMeters:8,consent:true});
  assert.ok(snap.expiresAt instanceof Date);
  assert.equal((await getLocationSnapshot(pool,key,first,'foreground'))!
   .point.latitude,tala.latitude);
  assert.equal(await getLocationSnapshot(pool,key,second,'foreground'),null);
  const stored=await pool.query<{ciphertext:Buffer}>(
   "SELECT ciphertext FROM tala_locations_v2.location_snapshots "+
   "WHERE owner_id=$1::uuid AND purpose='foreground'",[first.actorId]);
  assert.ok(!stored.rows[0]!.ciphertext.toString('utf8').includes('20.6534'));
  assert.equal((await clearLocationSnapshot(pool,second,'foreground')).cleared,false);
  assert.equal((await clearLocationSnapshot(pool,first,'foreground')).cleared,true);
  assert.equal(await getLocationSnapshot(pool,key,first,'foreground'),null);
  await putLocationSnapshot(pool,key,first,{purpose:'active_delivery',
   point:tala,accuracyMeters:15,consent:true});
  await pool.query("UPDATE tala_locations_v2.location_snapshots "+
   "SET updated_at=clock_timestamp()-interval '5 minutes',"+
   "expires_at=clock_timestamp()-interval '1 minute' WHERE owner_id=$1::uuid",
   [first.actorId]);
  assert.equal(await getLocationSnapshot(pool,key,first,'active_delivery'),null);
  const purged=await pruneExpiredSnapshots(pool,10);
  assert.ok(purged.purged>=1);
  assert.equal((await pruneExpiredSnapshots(pool,10)).purged,0);
 }finally{await pool.end();}
});
