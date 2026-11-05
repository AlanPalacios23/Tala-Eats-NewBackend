import test from 'node:test';
import assert from 'node:assert/strict';
import type {AddressInfo} from 'node:net';
import {createIntegrationLabHttpServer} from '../src/http-lab.js';
import {DATABASES,type DbKey} from '../src/admission.js';
import {IntegrationError} from '../src/events.js';
const urls=():Record<DbKey,string>=>Object.fromEntries(
 Object.entries(DATABASES).map(([key,db])=>[key,
  'postgresql://integration_ci:only_ci@127.0.0.1:5432/'+db])
) as Record<DbKey,string>;
test('M11 read-only shell reports source assembly without exposing writes',async()=>{
 const server=createIntegrationLabHttpServer({
  env:{NODE_ENV:'test',CORE_V2_INTEGRATION_RUNTIME:'isolated-lab',
   CORE_V2_INTEGRATION_WRITES_ENABLED:'false'},dbUrls:urls()
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 try{
  const health=await fetch(base+'/v1/integration/health');
  assert.equal(health.status,200);
  const body=await health.json() as Record<string,unknown>;
  assert.equal(body.tenSourcesAssembled,true);
  assert.equal(body.tenRealPortsConnected,false);
  assert.equal(body.commercialReady,false);
  assert.equal(health.headers.get('cache-control'),'private, no-store');
  const list=await fetch(base+'/v1/integration/modules');
  const data=await list.json() as {modules:Array<{sourceCopied:boolean}>};
  assert.equal(data.modules.length,10);
  assert.ok(data.modules.every(x=>x.sourceCopied));
  assert.equal((await fetch(base+'/v1/payments',{method:'POST',
   headers:{'content-type':'application/json'},body:'{}'})).status,404);
  assert.equal((await fetch(base+'/v1/integration/modules?admin=true')).status,404);
 }finally{
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
 }
});
test('M11 shell cannot run in production even with valid DB names',()=>{
 const original=process.env.NODE_ENV;
 try{
  process.env.NODE_ENV='production';
  assert.throws(()=>createIntegrationLabHttpServer({
   env:{NODE_ENV:'test',CORE_V2_INTEGRATION_RUNTIME:'isolated-lab'},
   dbUrls:urls()
  }),e=>e instanceof IntegrationError&&e.code==='M11_COMMERCIAL_DISABLED');
 }finally{
  if(original===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=original;
 }
});
