import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {createSecurityLabHttpServer} from '../src/http-lab.js';
import {signHostGrant,type HostGrant} from '../src/grants.js';

const url=process.env.SECURITY_CI_URL??'';
const enabled=/\/tala_security_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
test('M9 LAB HTTP: signed grant, no body-scopes, replay, step-up and protected metrics',
 {skip:!enabled,timeout:75000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:10});
 const keyring={gate01:randomBytes(32)},pseudonymKey=randomBytes(32);
 const admin='Bearer operator-'+id();
 const server=createSecurityLabHttpServer({
  pool,keyring,pseudonymKey,
  authenticateHost:async req=>req.headers.authorization===admin?
   {canMonitorSecurity:true}:null
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 async function call(method:string,path:string,body?:unknown,headers:Record<string,string>={}){
  const response=await fetch(base+path,{method,
   headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},
   ...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json() as Record<string,any>,
   cache:response.headers.get('cache-control'),
   cors:response.headers.get('access-control-allow-origin')};
 }
 function grant(action:HostGrant['action'],resourceId:string,assurance:'step_up'|'session'){
  const now=Math.floor(Date.now()/1000);
  const signed:HostGrant={version:1,issuer:'tala-trusted-gateway-lab',
   audience:'m9-security-lab',grantId:id(),subjectId:id(),resourceId,
   action,assurance,assuranceAt:assurance==='step_up'?now-10:null,
   issuedAt:now-1,expiresAt:now+90};
  return signHostGrant(signed,'gate01',keyring);
 }
 try{
  const health=await call('GET','/v1/security/health');
  assert.equal(health.status,200);
  assert.equal(health.body.liveProtectionEnabled,false);
  assert.equal((await call('GET','/v1/security/metrics')).status,401);
  assert.equal((await call('GET','/v1/security/metrics',undefined,
   {authorization:admin})).status,200);
  const resourceId=id();
  const action='payments.refund.request';
  const request={grant:grant(action,resourceId,'session'),action,resourceId};
  assert.equal((await call('POST','/v1/security/authorize',
   {...request,canBypassMFA:true})).status,400);
  assert.equal((await call('POST','/v1/security/authorize',request)).status,403);
  const fresh={grant:grant(action,resourceId,'step_up'),action,resourceId};
  const wrong=await call('POST','/v1/security/authorize',{
   ...fresh,resourceId:id()});
  assert.equal(wrong.status,403);
  const good=await call('POST','/v1/security/authorize',fresh);
  assert.equal(good.status,200);
  assert.equal(good.body.code,'M9_ALLOW');
  assert.equal(good.cache,'private, no-store');
  assert.equal(good.cors,null);
  const replay=await call('POST','/v1/security/authorize',fresh);
  assert.equal(replay.status,409);
  assert.equal(replay.body.code,'M9_GRANT_REPLAYED');
  const alteredLast=fresh.grant.endsWith('A')?'B':'A';
  const forged=await call('POST','/v1/security/authorize',
   {...fresh,grant:fresh.grant.slice(0,-1)+alteredLast});
  assert.equal(forged.status,401);
  const metrics=await call('GET','/v1/security/metrics',undefined,
   {authorization:admin});
  assert.equal(metrics.body.aggregateOnly,true);
  assert.ok(metrics.body.actions.some((x:{decision:string})=>
   x.decision==='deny_replay'));
  assert.equal(Object.hasOwn(metrics.body,'subjectId'),false);
  assert.equal((await call('GET','/v1/security/authorize')).status,404);
 }finally{
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  await pool.end();
 }
});
test('M9 LAB refuses HTTP server start with NODE_ENV production',()=>{
 const prior=process.env.NODE_ENV;
 try{
  process.env.NODE_ENV='production';
  assert.throws(()=>createSecurityLabHttpServer({
   pool:new pg.Pool({connectionString:'postgresql://invalid'}),
   keyring:{gate01:randomBytes(32)},pseudonymKey:randomBytes(32),
   authenticateHost:async()=>null
  }),/M9_LAB_HTTP_DISABLED/);
 }finally{
  if(prior===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=prior;
 }
});
