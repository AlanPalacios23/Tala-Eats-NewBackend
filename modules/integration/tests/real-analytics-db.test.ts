import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {publishEvent,claimDelivery,deliverOnce,
 acknowledgeDelivery} from '../src/bridge.js';
import {IntegrationError,type IntegrationEvent} from '../src/events.js';
import {createAnalyticsLabConsumer} from '../adapters/analytics-lab.js';
import {merchantAnalytics} from '../../analytics/src/analytics.js';
import type {IssuerKeys} from '../../analytics/src/contract.js';

const bridgeUrl=process.env.INTEGRATION_CI_URL??'';
const analyticsUrl=process.env.ANALYTICS_CI_URL??'';
const enabled=bridgeUrl.includes('/tala_integration_v2_test')&&
 analyticsUrl.includes('/tala_analytics_v2_test');
const uuid=()=>randomUUID();
const stamp=()=>new Date(Math.floor(Date.now()/1000)*1000)
 .toISOString().replace('.000Z','Z');
const today=()=>stamp().slice(0,10);
const keys:IssuerKeys={
 orders:{sample01:randomBytes(32)},
 payments:{sample01:randomBytes(32)},
 logistics:{sample01:randomBytes(32)}
};
function logisticsEvent(merchantId:string,orderId:string):IntegrationEvent{
 return {schemaVersion:1,eventId:uuid(),source:'logistics',
  kind:'logistics.delivery_completed',merchantId,orderId,occurredAt:stamp()};
}
test('M11 -> real M10: durable delivery event becomes one analytics fact, not a financial fact',
 {skip:!enabled,timeout:90000},async()=>{
 const bridgePool=new pg.Pool({connectionString:bridgeUrl,max:12});
 const analyticsPool=new pg.Pool({connectionString:analyticsUrl,max:12});
 const adapter=createAnalyticsLabConsumer({analyticsPool,keys,kid:'sample01'});
 try{
  const merchantId=uuid(),first=logisticsEvent(merchantId,uuid());
  const created=await publishEvent(bridgePool,{
   trustedHost:true,source:'logistics'
  },first);
  assert.equal(created.consumers,2);
  const result=await deliverOnce(bridgePool,'analytics',adapter);
  assert.equal('delivered' in result&&result.delivered,true);
  const report=await merchantAnalytics(analyticsPool,{
   actorId:uuid(),authenticated:true,merchantId,
   canReadMerchantAnalytics:true
  },merchantId,today(),today());
  assert.equal(report.totals.deliveriesCompleted,'1');
  assert.equal(report.totals.paymentsConfirmed,'0');
  assert.equal(report.totals.orderGmvCents,'0');
  assert.equal((await publishEvent(bridgePool,{
   trustedHost:true,source:'logistics'
  },first)).duplicate,true);
  assert.equal((await merchantAnalytics(analyticsPool,{
   actorId:uuid(),authenticated:true,merchantId,
   canReadMerchantAnalytics:true
  },merchantId,today(),today())).totals.deliveriesCompleted,'1');

  const second=logisticsEvent(merchantId,uuid());
  await publishEvent(bridgePool,{trustedHost:true,source:'logistics'},second);
  const leased=await claimDelivery(bridgePool,'analytics');
  assert.ok(leased?.event.eventId===second.eventId);
  // Simulate worker crash AFTER M10 persisted the fact but BEFORE M11 ACK.
  await adapter.handle(leased.event,leased.event.eventId+'|analytics');
  await bridgePool.query('UPDATE tala_integration_v2.deliveries '+
   "SET lease_until=clock_timestamp()-interval '1 second' "+
   'WHERE event_id=$1::uuid AND consumer=$2',[second.eventId,'analytics']);
  const retry=await deliverOnce(bridgePool,'analytics',adapter);
  assert.equal('delivered' in retry&&retry.delivered,true);
  assert.equal('eventId' in retry&&retry.eventId,second.eventId);
  await assert.rejects(acknowledgeDelivery(bridgePool,leased),
   e=>e instanceof IntegrationError&&e.code==='M11_STALE_LEASE');

  const after=await merchantAnalytics(analyticsPool,{
   actorId:uuid(),authenticated:true,merchantId,
   canReadMerchantAnalytics:true
  },merchantId,today(),today());
  assert.equal(after.totals.deliveriesCompleted,'2');
  assert.equal(after.totals.paymentsConfirmed,'0');
  assert.equal(after.totals.refundsConfirmed,'0');
  assert.equal(after.totals.orderGmvCents,'0');
  const facts=await analyticsPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_analytics_v2.delivery_facts '+
   'WHERE merchant_id=$1::uuid',[merchantId]);
  assert.equal(facts.rows[0]?.n,2);
  await assert.rejects(adapter.handle({...second,
   kind:'orders.order_created',source:'orders'},second.eventId+'|analytics'),
   e=>e instanceof IntegrationError&&e.code==='M11_CONSUMER_KIND_INVALID');
 }finally{await Promise.all([bridgePool.end(),analyticsPool.end()]);}
});
