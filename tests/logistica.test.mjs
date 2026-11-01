import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planCourierAssignment} from '../src/modules/modulo-2-logistica/index.ts';
const orderId='00000000-0000-4000-8000-000000000001';
const restaurantId='00000000-0000-4000-8000-000000000002';
const request={orderId,restaurantId,fulfillment:'delivery',orderStatus:'ready',deliveryZone:'tala'};
const now=1_790_000_000_000;
const courier=(n,o={})=>({
  courierId:'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),
  approved:true,online:true,serviceZones:['tala'],
  activeDeliveries:0,maxConcurrentDeliveries:2,lastSeenAtMs:now-20_000,...o
});
test('Logística: elige aprobados disponibles y menor carga en zona',()=>{
  assert.deepEqual(planCourierAssignment(request,[
    courier(1,{activeDeliveries:1}),courier(2,{activeDeliveries:0}),
    courier(3,{activeDeliveries:0})
  ],now),{decision:'ASSIGN',orderId,courierId:courier(2).courierId});
});
test('Logística: resultado determinista sin importar orden de entrada',()=>{
  const list=[courier(2),courier(1)];
  assert.deepEqual(planCourierAssignment(request,list,now),
    planCourierAssignment(request,[...list].reverse(),now));
});
test('Logística: no despacha pickup ni pedidos en preparación',()=>{
  assert.equal(planCourierAssignment({...request,fulfillment:'pickup'},[courier(1)],now).decision,'NOT_ELIGIBLE');
  assert.equal(planCourierAssignment({...request,orderStatus:'preparing'},[courier(1)],now).decision,'NOT_ELIGIBLE');
});
test('Logística: rechaza sin red, sin aprobación, ocupados, fuera de zona y presencia antigua',()=>{
  const list=[
    courier(1,{online:false}),
    courier(2,{approved:false}),
    courier(3,{activeDeliveries:2}),
    courier(4,{serviceZones:['tequila']}),
    courier(5,{lastSeenAtMs:now-120_001}),
    courier(6,{lastSeenAtMs:now+1}),
  ];
  assert.deepEqual(planCourierAssignment(request,list,now),{
    decision:'NO_AVAILABLE_COURIER',orderId
  });
});
test('Logística: inputs malformados fallan y límites de volumen protegidos',()=>{
  assert.throws(()=>planCourierAssignment({...request,orderId:'invalid'},[],now),/LOGISTICS_REQUEST_INVALID/);
  assert.throws(()=>planCourierAssignment({...request,deliveryZone:'../../../'},[],now),/LOGISTICS_REQUEST_INVALID/);
  assert.throws(()=>planCourierAssignment(request,Array.from({length:501},()=>courier(1)),now),/LOGISTICS_REQUEST_INVALID/);
  assert.throws(()=>planCourierAssignment(request,[],NaN),/LOGISTICS_REQUEST_INVALID/);
});
test('Arquitectura: Logística no importa Pedidos, dinero, BD ni servidor',()=>{
  for(const path of ['contracts.ts','assignment-policy.ts','index.ts']){
    const source=readFileSync('src/modules/modulo-2-logistica/'+path,'utf8');
    assert.doesNotMatch(source,/\bfrom\s+['"][^'"]*modulo-1-pedidos/);
    assert.doesNotMatch(source,/\bfrom\s+['"](?:pg|express)/);
    assert.doesNotMatch(source,/CORE_V2_DATABASE_URL|STRIPE_SECRET_KEY/);
  }
});
