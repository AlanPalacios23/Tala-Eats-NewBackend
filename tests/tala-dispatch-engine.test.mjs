import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluateTalaDispatch,TALA_DISPATCH_ENGINE_VERSION,
  planCourierAssignment,isDispatchTriggerReady}
  from '../src/modules/modulo-2-logistica/index.ts';

const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const req={orderId:id(1),restaurantId:id(2),
  fulfillment:'delivery',orderStatus:'ready',deliveryZone:'tala'};
const now=1_790_000_000_000;
const courier=(n,overrides={})=>({
  courierId:id(n),approved:true,online:true,serviceZones:['tala'],
  activeDeliveries:0,maxConcurrentDeliveries:2,lastSeenAtMs:now-1000,
  ...overrides
});

test('TALA v1: metodología Trigger -> Availability -> Load -> Atomic Assignment',()=>{
  const v=evaluateTalaDispatch(req,[courier(3)],now);
  assert.equal(v.engine,'TALA Dispatch Engine');
  assert.equal(v.version,TALA_DISPATCH_ENGINE_VERSION);
  assert.equal(v.decision,'PROPOSE');
  assert.equal(v.reason,'CANDIDATE_REQUIRES_DB_COMMIT');
  assert.equal(v.courierId,id(3));
  assert.deepEqual(v.stages.map(s=>[s.name,s.outcome]),[
    ['TRIGGER','PASS'],['AVAILABILITY','PASS'],
    ['LOAD','PASS'],['ATOMIC_ASSIGNMENT','PENDING']
  ]);
  assert.equal(v.stages.at(-1).outcome,'PENDING',
    'a pure proposal MUST NOT claim a successful DB reservation');
});
test('TALA v1: pickup y pedido aún en cocina bloquean fase Trigger',()=>{
  for(const request of [
    {...req,fulfillment:'pickup'},
    {...req,orderStatus:'preparing'},
    {...req,orderStatus:'cancelled'}
  ]){
    const v=evaluateTalaDispatch(request,[courier(3)],now);
    assert.equal(isDispatchTriggerReady(request),false);
    assert.equal(v.decision,'NOT_ELIGIBLE');
    assert.equal(v.reason,'ORDER_NOT_READY');
    assert.deepEqual(v.stages.map(s=>s.name),['TRIGGER']);
  }
});
test('TALA v1: deniega drivers sin aprobar, offline, de otra zona y heartbeat obsoleto',()=>{
  const v=evaluateTalaDispatch(req,[
    courier(3,{approved:false}),courier(4,{online:false}),
    courier(5,{serviceZones:['tequila']}),
    courier(6,{lastSeenAtMs:now-120_001}),
    courier(7,{lastSeenAtMs:now+1}),
  ],now);
  assert.equal(v.decision,'NO_AVAILABLE_COURIER');
  assert.equal(v.reason,'NO_ONLINE_COURIER');
  assert.deepEqual(v.stages.map(s=>[s.name,s.outcome]),[
    ['TRIGGER','PASS'],['AVAILABILITY','BLOCKED']
  ]);
});
test('TALA v1: capacidad llena se distingue de repartidor desconectado',()=>{
  const v=evaluateTalaDispatch(req,[
    courier(3,{activeDeliveries:2,maxConcurrentDeliveries:2}),
    courier(4,{activeDeliveries:1,maxConcurrentDeliveries:1})
  ],now);
  assert.equal(v.decision,'NO_AVAILABLE_COURIER');
  assert.equal(v.reason,'NO_CAPACITY');
  assert.equal(v.stages.at(-1).name,'LOAD');
  assert.equal(v.stages.at(-1).outcome,'BLOCKED');
});
test('TALA v1: orden determinista por carga y UUID, respeta borde de heartbeat',()=>{
  const list=[courier(3,{activeDeliveries:1}),
    courier(5,{lastSeenAtMs:now-120_000}),
    courier(4)];
  const r=evaluateTalaDispatch(req,list,now);
  assert.equal(r.courierId,id(4));
  assert.equal(evaluateTalaDispatch(req,[...list].reverse(),now).courierId,id(4));
  assert.equal(planCourierAssignment(req,list,now).courierId,id(4));
  assert.equal(evaluateTalaDispatch(req,[courier(5,{lastSeenAtMs:now-120_000})],now).decision,'PROPOSE');
});
test('TALA v1: rechaza entradas deformadas y lista excesiva',()=>{
  for(const invalid of [
    [{...req,orderId:'fake'},[],now],
    [{...req,deliveryZone:'../../secret'},[],now],
    [req,[],NaN],
    [req,Array.from({length:501},()=>courier(3)),now]
  ])assert.throws(()=>evaluateTalaDispatch(...invalid),/TALA_DISPATCH_INPUT_INVALID/);
});
test('TALA v1: engine puro; sin imports de Pedidos, dinero, GPS o SQL',()=>{
  const source=readFileSync('src/modules/modulo-2-logistica/tala-dispatch-engine.ts','utf8');
  assert.doesNotMatch(source,/from\s+['"][^'"]*modulo-1-pedidos/);
  assert.doesNotMatch(source,/from\s+['"](?:pg|express)/);
  assert.doesNotMatch(source,/CORE_V2_DATABASE_URL|STRIPE_SECRET_KEY/);
});
