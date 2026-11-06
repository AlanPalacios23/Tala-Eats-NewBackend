import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleIsolatedLab9,listenIsolatedLab9,DOMAINS}
 from '../src/assembly-lab9.js';
import {DATABASES,type DbKey} from '../src/admission.js';
import {IntegrationError} from '../src/events.js';

function dbUrls():Record<DbKey,string>{
 return Object.fromEntries(Object.entries(DATABASES).map(([key,name])=>
  [key,'postgresql://integration_ci:lab_only@127.0.0.1:5432/'+name]
 )) as Record<DbKey,string>;
}
function args(){
 return {env:{NODE_ENV:'test',CORE_V2_INTEGRATION_RUNTIME:'isolated-lab',
  CORE_V2_WRITES_ENABLED:'false'},dbUrls:dbUrls()};
}
test('LAB9 fails closed when NODE_ENV is production, runtime unapproved or DB remote',
 async()=>{
 const before=process.env.NODE_ENV;
 try{
  process.env.NODE_ENV='production';
  await assert.rejects(assembleIsolatedLab9(args()),(e:unknown)=>
   e instanceof IntegrationError&&e.code==='M11_COMMERCIAL_DISABLED');
 }finally{
  if(before===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=before;
 }
 await assert.rejects(assembleIsolatedLab9({
  ...args(),env:{NODE_ENV:'test',CORE_V2_INTEGRATION_RUNTIME:'production'}
 }),(e:unknown)=>e instanceof IntegrationError&&
    e.code==='M11_COMMERCIAL_DISABLED');
 const remote=dbUrls();
 remote.finance='postgresql://integration_ci:lab_only@production-db.example:5432/tala_finance_v2_test';
 await assert.rejects(assembleIsolatedLab9({...args(),dbUrls:remote}),
  (e:unknown)=>e instanceof IntegrationError&&
    e.code==='M11_ISOLATED_DATABASE_REQUIRED');
});
test('LAB9 loads ten real domain exports and delegates ONLY the real health handlers',
 {timeout:120000},async()=>{
 const before=process.env.CORE_V2_INTEGRATION_RUNTIME;
 process.env.CORE_V2_INTEGRATION_RUNTIME='isolated-lab';
 let assembly:Awaited<ReturnType<typeof assembleIsolatedLab9>>|undefined;
 try{
  assembly=await assembleIsolatedLab9(args());
  assert.deepEqual([...assembly.modules.keys()],DOMAINS);
  assert.equal(assembly.modules.get('logistics')?.kind,'internal');
  assert.equal(assembly.modules.get('finance')?.kind,'internal');
  const port=await listenIsolatedLab9(assembly);
  const base='http://127.0.0.1:'+port;
  const get=async(path:string,method='GET')=>{
   const res=await fetch(base+path,{method});
   return {status:res.status,
    body:await res.json() as Record<string,unknown>,
    cache:res.headers.get('cache-control'),
    cors:res.headers.get('access-control-allow-origin')};
  };
  const health=await get('/v2/health');
  assert.equal(health.status,200);
  assert.equal(health.body.domainsLoaded,10);
  assert.equal(health.body.oneProcess,true);
  assert.equal(health.body.commercialReady,false);
  assert.equal(health.cache,'private, no-store');
  const ready=await get('/v2/ready');
  assert.equal(ready.status,503);
  assert.equal(ready.body.ready,false);
  const mods=await get('/v2/modules');
  assert.equal(mods.status,200);
  assert.deepEqual((mods.body.modules as Array<{domain:unknown}>)
   .map(x=>x.domain),DOMAINS);
  for(const endpoint of [
   '/api/v2/health','/v1/notifications/health',
   '/v1/restaurants/health','/v1/locations/health',
   '/v1/payments/health','/v1/security/health','/v1/analytics/health'
  ]){
   const result=await get(endpoint);
   assert.equal(result.status,200,endpoint+' '+JSON.stringify(result.body));
   assert.notEqual(result.body.commercialReady,true);
  }
  const users=await get('/v1/users/health');
  assert.equal(users.status,503);
  assert.equal(users.body.dbReady,false);
  const forbidden:Array<[string,string]>=[
   ['POST','/api/v2/orders'],['POST','/v1/users/login'],
   ['POST','/v1/payments/stripe-test-webhook'],
   ['POST','/v1/payments/stripe-webhook'],
   ['POST','/v1/restaurants'],['POST','/v1/analytics/events'],
   ['POST','/v1/security/authorize'],['GET','/v1/notifications/inbox'],
   ['GET','/v1/locations/zones'],['GET','/v2/modules?admin=true']
  ];
  for(const [method,endpoint] of forbidden){
   const res=await get(endpoint,method);
   assert.equal(res.status,503,method+' '+endpoint);
   assert.equal(res.body.error,'M11_BUSINESS_ROUTES_DISABLED');
   assert.equal(res.cors,null);
  }
  assert.equal((await get('/'+('x'.repeat(2500)))).status,400);
 }finally{
  if(assembly)await assembly.close();
  if(before===undefined)delete process.env.CORE_V2_INTEGRATION_RUNTIME;
  else process.env.CORE_V2_INTEGRATION_RUNTIME=before;
 }
});
