import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {IntegrationError} from '../src/events.js';
import {createM11AuthenticatedLabGateway,listenM11AuthenticatedLabGateway,
 type TrustedCancelPort} from '../src/authenticated-gateway-lab.js';

const env={NODE_ENV:'test',CORE_V2_INTEGRATION_RUNTIME:'isolated-lab'};
const token='a'.repeat(43);
const forbidden=(fn:()=>unknown,code:string)=>
 assert.throws(fn,e=>e instanceof IntegrationError&&e.code===code);
test('M11 RC2 refuses production, public flags and no trusted cancel authorizer',()=>{
 const cancel:TrustedCancelPort={
  authorizeLabOrderCancel:async({orderId})=>({
   authorized:true,resourceId:orderId,action:'orders.cancel',
   orderMutationPerformed:false
  })
 };
 forbidden(()=>createM11AuthenticatedLabGateway({env:{
  ...env,NODE_ENV:'production'},cancel}),'M11_COMMERCIAL_DISABLED');
 forbidden(()=>createM11AuthenticatedLabGateway({env:{
  ...env,CORE_V2_INTEGRATION_PUBLIC_HTTP_ENABLED:'true'},cancel}),
 'M11_COMMERCIAL_DISABLED');
 forbidden(()=>createM11AuthenticatedLabGateway({env:{
  ...env,CORE_V2_INTEGRATION_WRITES_ENABLED:'true'},cancel}),
 'M11_COMMERCIAL_DISABLED');
 forbidden(()=>createM11AuthenticatedLabGateway({env,
  cancel:{} as TrustedCancelPort}),'M11_TRUSTED_GATE_REQUIRED');
});
test('M11 RC2 HTTP gateway restricts every route except scoped authz LAB read',async()=>{
 const orderId=randomUUID(),requested:string[]=[];
 const cancel:TrustedCancelPort={authorizeLabOrderCancel:async(input)=>{
  requested.push(input.orderId);
  if(input.sessionToken!==token)
   throw new IntegrationError('M11_IDENTITY_NOT_AUTHENTICATED');
  return {authorized:true,resourceId:input.orderId,
   action:'orders.cancel',orderMutationPerformed:false};
 }};
 const server=createM11AuthenticatedLabGateway({env,cancel});
 const port=await listenM11AuthenticatedLabGateway(server);
 const base='http://127.0.0.1:'+port;
 const call=async(path:string,init?:RequestInit)=>{
  const r=await fetch(base+path,init);
  return {status:r.status,body:await r.json() as Record<string,unknown>,
   cache:r.headers.get('cache-control'),cors:r.headers.get('access-control-allow-origin')};
 };
 try{
  assert.equal((await call('/v2/health')).status,200);
  const ready=await call('/v2/ready');
  assert.equal(ready.status,503);
  assert.equal(ready.body.ready,false);
  const path='/v2/lab/orders/'+orderId+'/can-cancel';
  assert.equal((await call(path)).status,401);
  assert.equal((await call(path,{headers:{authorization:'Bearer x'}})).status,401);
  assert.equal((await call(path,{headers:{authorization:'Bearer '+token,
   cookie:'session=illegal'}})).status,400);
  assert.equal((await call(path+'?token='+token,{headers:{
   authorization:'Bearer '+token}})).status,503);
  const ok=await call(path,{headers:{authorization:'Bearer '+token}});
  assert.equal(ok.status,200);
  assert.equal(ok.body.authorized,true);
  assert.equal(ok.body.orderMutationPerformed,false);
  assert.equal(ok.body.commercialReady,false);
  assert.equal(ok.cache,'private, no-store');
  assert.equal(ok.cors,null);
  assert.deepEqual(requested,[orderId]);
  const denied=await call(path,{headers:{authorization:'Bearer '+'x'.repeat(43)}});
  assert.equal(denied.status,401);
  assert.equal(denied.body.error,'M11_ACCESS_DENIED');
  assert.equal((await call('/v2/orders',{method:'POST'})).status,503);
  assert.equal((await call('/v2/lab/orders/'+orderId+'/cancel',{method:'POST'})).status,503);
  assert.equal((await call('/v2/merchants')).status,503);
 }finally{await new Promise<void>((resolve,reject)=>
  server.close(err=>err?reject(err):resolve()));}
});
test('M11 RC2 gateway rejects forged trusted-port response without M1 mutation',async()=>{
 const orderId=randomUUID();
 const server=createM11AuthenticatedLabGateway({env,
  cancel:{authorizeLabOrderCancel:async()=>({
   authorized:true,resourceId:randomUUID(),action:'orders.cancel',
   orderMutationPerformed:false
  })}});
 const port=await listenM11AuthenticatedLabGateway(server);
 try{
  const r=await fetch('http://127.0.0.1:'+port+'/v2/lab/orders/'+
   orderId+'/can-cancel',{headers:{authorization:'Bearer '+token}});
  assert.equal(r.status,403);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
