import test from 'node:test';
import assert from 'node:assert/strict';
import {validGeoPoint,straightLineMeters,rankGeoCandidates,TALA_GEO_VERSION}
 from '../src/modules/modulo-2-logistica/index.ts';
const p=(latitude,longitude)=>({latitude,longitude});
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const candidate=(n,d,more={})=>({
 courierId:id(n),distanceMeters:d,activeDeliveries:0,remainingCapacity:1,
 positionAgeSeconds:1,...more
});
test('Geo: Haversine same point is zero',()=>{
 assert.equal(straightLineMeters(p(20.653,-103.70),p(20.653,-103.70)),0);
 assert.equal(TALA_GEO_VERSION,'2.0.0-lab');
});
test('Geo: 1 degree at equator approximately 111.2 km, symmetric',()=>{
 const d=straightLineMeters(p(0,0),p(0,1));
 assert.ok(d>111000&&d<111400);
 assert.equal(straightLineMeters(p(0,1),p(0,0)),d);
});
test('Geo: dateline shortest arc, not Earth circumference',()=>{
 const d=straightLineMeters(p(0,179.9),p(0,-179.9));
 assert.ok(d>21000&&d<24000);
});
test('Geo: rejects out-of-range and nonfinite GPS',()=>{
 for(const value of [p(91,0),p(-91,0),p(0,181),p(0,-181),
  p(NaN,0),p(0,Infinity),null,[],{latitude:'20',longitude:1}]){
  assert.equal(validGeoPoint(value),false);
  assert.throws(()=>straightLineMeters(p(0,0),value),/LOGISTICS_GEO_INVALID/);
 }
 assert.equal(validGeoPoint(p(-90,-180)),true);
 assert.equal(validGeoPoint(p(90,180)),true);
});
test('Geo: shortest distance, tie lower load, tie UUID, no input mutation',()=>{
 const items=[candidate(3,1000),candidate(2,900,{activeDeliveries:1}),
  candidate(1,900,{activeDeliveries:0}),candidate(4,30000)];
 const before=structuredClone(items);
 assert.deepEqual(rankGeoCandidates(items).map(c=>c.courierId),[id(1),id(2),id(3)]);
 assert.deepEqual(items,before);
});
test('Geo: rejects tampered or stale candidates, invalid radii',()=>{
 assert.throws(()=>rankGeoCandidates([candidate(1,10,{remainingCapacity:0})]),
  /LOGISTICS_GEO_CANDIDATE_INVALID/);
 assert.throws(()=>rankGeoCandidates([candidate(1,10,{positionAgeSeconds:121})]),
  /LOGISTICS_GEO_CANDIDATE_INVALID/);
 assert.throws(()=>rankGeoCandidates([candidate(1,-10)]),
  /LOGISTICS_GEO_CANDIDATE_INVALID/);
 assert.throws(()=>rankGeoCandidates([],0),/LOGISTICS_GEO_RANK_INVALID/);
 assert.throws(()=>rankGeoCandidates([],100001),/LOGISTICS_GEO_RANK_INVALID/);
});
