import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {IntegrationError,validateEnvelope,routing} from '../src/events.js';
import {checkIntegrationAdmission,DATABASES,type DbKey} from '../src/admission.js';
import {runIsolatedTenModuleSmoke,type TenModulePorts} from '../src/scenario.js';

const id=()=>randomUUID();
const at=()=>new Date(Math.floor(Date.now()/1000)*1000)
 .toISOString().replace('.000Z','Z');
const payload=()=>({
 schemaVersion:1 as const,eventId:id(),source:'orders' as const,
 kind:'orders.order_created' as const,merchantId:id(),orderId:id(),
 occurredAt:at()
});
const invalid=(fn:()=>unknown,code:string)=>assert.throws(fn,
 e=>e instanceof IntegrationError&&e.code===code);
const denied=(p:Promise<unknown>,code:string)=>assert.rejects(p,
 e=>e instanceof IntegrationError&&e.code===code);
function urls():Record<DbKey,string>{
 return Object.fromEntries(Object.entries(DATABASES).map(([k,v])=>
  [k,'postgresql://integration_ci:local-only@127.0.0.1:5432/'+v]
 )) as Record<DbKey,string>;
}
test('M11 routes are closed, PII-free and bound to source module',()=>{
 const value=payload();
 assert.deepEqual(validateEnvelope(value),value);
 assert.deepEqual(routing('orders.order_created'),['notifications']);
 assert.deepEqual(routing('restaurants.order_ready'),
  ['logistics','notifications']);
 assert.deepEqual(routing('logistics.delivery_completed'),
  ['notifications','analytics']);
 invalid(()=>validateEnvelope({...value,customerPhone:'+5211111111111'}),
  'M11_EVENT_INVALID');
 invalid(()=>validateEnvelope({...value,amountCents:10000}),
  'M11_EVENT_INVALID');
 invalid(()=>validateEnvelope({...value,kind:'payments.live_charge'}),
  'M11_EVENT_INVALID');
 invalid(()=>validateEnvelope({...value,source:'payments'}),
  'M11_SOURCE_MISMATCH');
 invalid(()=>validateEnvelope({...value,eventId:'anything'}),
  'M11_EVENT_INVALID');
 invalid(()=>validateEnvelope({...value,occurredAt:'2026-02-30T00:00:00Z'}),
  'M11_TIME_INVALID');
});
test('M11 rejects production, remote databases, wrong schemas and write flags',()=>{
 const env={'NODE_ENV':'test','CORE_V2_INTEGRATION_RUNTIME':'isolated-lab',
  'CORE_V2_INTEGRATION_WRITES_ENABLED':'false'};
 const accepted=checkIntegrationAdmission(env,urls());
 assert.equal(accepted.admitted,true);
 assert.equal(accepted.commercialReady,false);
 assert.equal(accepted.separateDatabases,true);
 assert.equal(accepted.moduleCount,10);
 invalid(()=>checkIntegrationAdmission({...env,NODE_ENV:'production'},urls()),
  'M11_COMMERCIAL_DISABLED');
 invalid(()=>checkIntegrationAdmission({...env,
  CORE_V2_INTEGRATION_LIVE_PAYMENTS_ENABLED:'true'},urls()),
  'M11_COMMERCIAL_DISABLED');
 invalid(()=>checkIntegrationAdmission({...env,
  CORE_V2_INTEGRATION_PAYOUTS_ENABLED:'true'},urls()),
  'M11_COMMERCIAL_DISABLED');
 const remote=urls();remote.finance=remote.finance.replace('127.0.0.1',
  'tala-production.internal');
 invalid(()=>checkIntegrationAdmission(env,remote),
  'M11_ISOLATED_DATABASE_REQUIRED');
 const wrong=urls();wrong.payments=wrong.payments.replace(
  '/tala_payments_v2_test','/tala_payments_live');
 invalid(()=>checkIntegrationAdmission(env,wrong),
  'M11_ISOLATED_DATABASE_REQUIRED');
});
test('M11 isolated ten-domain scenario calls each distinct port in order without money writes',
 async()=>{
 const called:string[]=[];
 const mark=<T>(name:string,result:T)=>async()=>{called.push(name);return result;};
 const order={orderId:id(),merchantId:id(),customerId:id(),totalCents:49900};
 const ports:TenModulePorts={
  users:{verifyLabIdentity:mark('users',{verified:true})},
  security:{requireLabAuthorization:mark('security',{allowed:true})},
  locations:{verifyLabZone:mark('locations',{covered:true})},
  restaurants:{
   quoteLab:mark('restaurants:quote',
    {merchantId:order.merchantId,totalCents:49900}),
   prepareLab:mark('restaurants:ready',{ready:true})
  },
  orders:{createLabOrder:mark('orders',{
   orderId:order.orderId,merchantId:order.merchantId,totalCents:49900})},
  payments:{simulateLabPayment:mark('payments',{
   provider:'simulated_lab',livemode:false,amountCents:49900,
   confirmed:true})},
  logistics:{simulateLabDelivery:mark('logistics',{delivered:true})},
  finance:{previewLabLedger:mark('finance',{
   previewOnly:true,writesPerformed:false,amountCents:49900})},
  notifications:{queueLabNotification:mark('notifications',{queued:true})},
  analytics:{previewLabMetrics:mark('analytics',{
   derivedOnly:true,liveData:false})}
 };
 const ok=await runIsolatedTenModuleSmoke(ports,order);
 assert.equal(ok.modulesExercised,10);
 assert.equal(ok.liveWrites,false);
 assert.deepEqual(called,[
  'users','security','locations','restaurants:quote','orders',
  'payments','restaurants:ready','logistics','finance','notifications','analytics'
 ]);
 const evil={...ports,payments:{
  simulateLabPayment:async()=>({provider:'simulated_lab' as const,
   livemode:false as const,amountCents:49901,confirmed:true})
 }};
 await denied(runIsolatedTenModuleSmoke(evil,order),
  'M11_TEST_PAYMENT_REJECTED');
 const mismatch={...ports,restaurants:{...ports.restaurants,
  quoteLab:async()=>({merchantId:order.merchantId,totalCents:1200})}};
 await denied(runIsolatedTenModuleSmoke(mismatch,order),'M11_QUOTE_MISMATCH');
});
