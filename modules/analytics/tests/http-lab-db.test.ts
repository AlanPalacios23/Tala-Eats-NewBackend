import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {createAnalyticsLabHttpServer} from '../src/http-lab.js';
import {EVENT_ISSUERS,signAnalyticsEvent,type AnalyticsEvent,
 type Issuer,type IssuerKeys} from '../src/contract.js';

const url=process.env.ANALYTICS_CI_URL??'';
const enabled=/\/tala_analytics_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
const time=()=>new Date(Math.floor(Date.now()/1000)*1000)
 .toISOString().replace('.000Z','Z');
const day=()=>time().slice(0,10);
test('M10 LAB HTTP signed source, merchant isolation, admin view and no-store E2E',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 const keys:IssuerKeys={
  orders:{sign01:randomBytes(32)},
  payments:{sign01:randomBytes(32)},
  logistics:{sign01:randomBytes(32)}
 };
 const store=id(),other=id();
 const ownerToken='Bearer merchant-'+id(),adminToken='Bearer admin-'+id();
 const server=createAnalyticsLabHttpServer({
  pool,keys,
  authenticateHost:async req=>req.headers.authorization===ownerToken?{
   actorId:id(),authenticated:true,merchantId:store,
   canReadMerchantAnalytics:true
  }:req.headers.authorization===adminToken?{
   actorId:id(),authenticated:true,canReadPlatformAnalytics:true
  }:null
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 async function call(method:string,path:string,raw?:string,
  headers:Record<string,string>={}){
  const response=await fetch(base+path,{method,headers:{
   ...(raw===undefined?{}:{'content-type':'application/json'}),...headers
  },...(raw===undefined?{}:{body:raw})});
  return {status:response.status,body:await response.json() as Record<string,any>,
   cache:response.headers.get('cache-control'),
   cors:response.headers.get('access-control-allow-origin')};
 }
 function signed(kind:AnalyticsEvent['kind'],merchantId:string,
  orderId:string,amountCents:number,extra:Record<string,unknown>={}){
  const payload={eventId:id(),kind,merchantId,orderId,refundId:null,
   amountCents,occurredAt:time(),...extra};
  const raw=JSON.stringify(payload),issuer=EVENT_ISSUERS[kind];
  return {raw,headers:{'x-m10-issuer':issuer,'x-m10-key-id':'sign01',
   'x-m10-signature':signAnalyticsEvent(Buffer.from(raw),issuer,'sign01',keys)}};
 }
 try{
  const health=await call('GET','/v1/analytics/health');
  assert.equal(health.status,200);
  assert.equal(health.body.commercialAnalyticsEnabled,false);
  const order=id(),evt=signed('order.completed',store,order,49900);
  assert.equal((await call('POST','/v1/analytics/events',evt.raw)).status,401);
  const applied=await call('POST','/v1/analytics/events',evt.raw,evt.headers);
  assert.equal(applied.status,201);
  assert.equal(applied.body.applied,true);
  const repeat=await call('POST','/v1/analytics/events',evt.raw,evt.headers);
  assert.equal(repeat.status,200);
  assert.equal(repeat.body.duplicate,true);
  const bad=JSON.stringify({...JSON.parse(evt.raw),amountCents:90000});
  assert.equal((await call('POST','/v1/analytics/events',bad,evt.headers)).status,401);
  const withPii=signed('order.completed',store,id(),1000,
   {customerEmail:'private@example.com'});
  assert.equal((await call('POST','/v1/analytics/events',
   withPii.raw,withPii.headers)).status,400);
  const foreign=await call('GET','/v1/analytics/merchant/'+other+
   '?from='+day()+'&to='+day(),undefined,{authorization:ownerToken});
  assert.equal(foreign.status,403);
  const publicRead=await call('GET','/v1/analytics/merchant/'+store+
   '?from='+day()+'&to='+day());
  assert.equal(publicRead.status,401);
  const merchant=await call('GET','/v1/analytics/merchant/'+store+
   '?from='+day()+'&to='+day(),undefined,{authorization:ownerToken});
  assert.equal(merchant.status,200);
  assert.equal(merchant.body.scope,'merchant');
  assert.equal(merchant.body.totals.orderGmvCents,'49900');
  assert.equal(merchant.cache,'private, no-store');
  assert.equal(merchant.cors,null);
  const forbidden=await call('GET','/v1/analytics/platform?from='+
   day()+'&to='+day(),undefined,{authorization:ownerToken});
  assert.equal(forbidden.status,403);
  const admin=await call('GET','/v1/analytics/platform?from='+
   day()+'&to='+day(),undefined,{authorization:adminToken});
  assert.equal(admin.status,200);
  assert.equal(admin.body.scope,'platform');
  assert.ok(BigInt(admin.body.totals.orderGmvCents)>=49900n);
  assert.equal(Object.hasOwn(admin.body,'customerEmail'),false);
  assert.equal((await call('GET','/v1/analytics/platform?from='+day()+
   '&to='+day()+'&admin=true',undefined,{authorization:adminToken})).status,400);
 }finally{
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  await pool.end();
 }
});
test('M10 LAB refuses HTTP server start when NODE_ENV production',()=>{
 const prior=process.env.NODE_ENV;
 try{
  process.env.NODE_ENV='production';
  assert.throws(()=>createAnalyticsLabHttpServer({
   pool:new pg.Pool({connectionString:'postgresql://invalid'}),
   keys:{orders:{},payments:{},logistics:{}},
   authenticateHost:async()=>null
  }),/M10_LAB_HTTP_DISABLED/);
 }finally{
  if(prior===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=prior;
 }
});
