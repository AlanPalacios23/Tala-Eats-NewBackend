import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {assembleLabMonolith,listenLocalOnly} from '../src/assembly.js';
import {IntegrationError,DOMAINS,loadManifest} from '../src/manifest.js';

const root=join(process.cwd(),'.upstream');
const manifestFile=join(process.cwd(),'upstreams.json');
const requireSources=process.env.M11_REQUIRE_SOURCES==='1';
test('M11 start refuses production or missing explicit isolated-lab opt-in',async()=>{
 const manifest=await loadManifest(manifestFile);
 const prev={node:process.env.NODE_ENV,mode:process.env.M11_RUNTIME};
 try{
  process.env.NODE_ENV='production';
  process.env.M11_RUNTIME='isolated-lab';
  await assert.rejects(assembleLabMonolith(manifest,root),e=>
   e instanceof IntegrationError&&e.code==='M11_LAB_ONLY');
  process.env.NODE_ENV='test';
  delete process.env.M11_RUNTIME;
  await assert.rejects(assembleLabMonolith(manifest,root),e=>
   e instanceof IntegrationError&&e.code==='M11_LAB_ONLY');
 }finally{
  if(prev.node===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=prev.node;
  if(prev.mode===undefined)delete process.env.M11_RUNTIME;
  else process.env.M11_RUNTIME=prev.mode;
 }
});
test('M11 one-process gateway loads ten pinned real module exports and blocks commerce',
 {skip:!existsSync(root)&&!requireSources,timeout:120000},async()=>{
 const manifest=await loadManifest(manifestFile);
 const prev=process.env.M11_RUNTIME;
 process.env.M11_RUNTIME='isolated-lab';
 const assembly=await assembleLabMonolith(manifest,root);
 try{
  assert.equal(assembly.modules.size,10);
  assert.deepEqual([...assembly.modules.keys()],DOMAINS);
  assert.equal(assembly.modules.get('logistics')?.kind,'internal');
  assert.equal(assembly.modules.get('finance')?.kind,'internal');
  for(const domain of DOMAINS)
   assert.match(assembly.modules.get(domain)?.sha??'',/^[a-f0-9]{40}$/);
  const port=await listenLocalOnly(assembly);
  const base='http://127.0.0.1:'+port;
  const call=async(method:string,path:string,body?:string)=>{
   const response=await fetch(base+path,{method,
    ...(body===undefined?{}:{body,headers:{'content-type':'application/json'}})});
   return {status:response.status,
    json:await response.json() as Record<string,any>,
    cache:response.headers.get('cache-control'),
    cors:response.headers.get('access-control-allow-origin')};
  };
  const health=await call('GET','/v2/health');
  assert.equal(health.status,200);
  assert.equal(health.json.domainsLoaded,10);
  assert.equal(health.json.commercialReady,false);
  assert.equal(health.json.businessEnabled,false);
  const ready=await call('GET','/v2/ready');
  assert.equal(ready.status,503);
  assert.equal(ready.json.ready,false);
  const list=await call('GET','/v2/modules');
  assert.equal(list.json.modules.length,10);
  for(const x of list.json.modules){
   assert.equal(x.loaded,true);
   if(x.domain==='logistics'||x.domain==='finance')
    assert.equal(x.kind,'internal');
  }
  const delegated=[
   ['/api/v2/health','orders'],
   ['/v1/notifications/health','notifications'],
   ['/v1/restaurants/health','restaurants'],
   ['/v1/locations/health','locations'],
   ['/v1/payments/health','payments'],
   ['/v1/security/health','security'],
   ['/v1/analytics/health','analytics']
  ];
  for(const [path,domain] of delegated){
   const response=await call('GET',path);
   assert.equal(response.status,200,domain+': '+JSON.stringify(response.json));
   assert.equal(response.json.commercialReady,false,
    domain+' must never claim commercial readiness');
  }
  const users=await call('GET','/v1/users/health');
  assert.equal(users.status,503);
  assert.equal(users.json.reason,'M4_DATABASE_NOT_COMPOSED');
  const forbidden=[
   ['POST','/api/v2/orders'],
   ['POST','/v1/users/login'],
   ['POST','/v1/payments/lab-webhook'],
   ['POST','/v1/payments/stripe-test-webhook'],
   ['POST','/v1/analytics/events'],
   ['POST','/v1/security/authorize'],
   ['POST','/v1/restaurants'],
   ['GET','/v1/analytics/platform?from=2026-11-01&to=2026-11-05'],
   ['GET','/v1/locations/zones'],
   ['GET','/v1/notifications/inbox'],
   ['GET','/v2/modules?unsafe=true']
  ];
  for(const [method,path] of forbidden){
   const r=await call(method!,path!);
   assert.equal(r.status,503,'request must be disabled: '+path);
   assert.equal(r.json.error,'M11_BUSINESS_ROUTES_DISABLED');
   assert.equal(r.cors,null);
  }
  const notGet=await call('POST','/v1/analytics/health','{}');
  assert.equal(notGet.status,503);
  const tooLong=await call('GET','/'+('a'.repeat(3000)));
  assert.equal(tooLong.status,400);
  assert.equal(health.cache,'private, no-store');
  assert.equal(health.cors,null);
 }finally{
  await assembly.close();
  if(prev===undefined)delete process.env.M11_RUNTIME;
  else process.env.M11_RUNTIME=prev;
 }
});
