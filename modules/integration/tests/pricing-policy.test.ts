import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteOrder,PRICING_POLICY_VERSION}
 from '../../../src/modules/orders/pricing.ts';
import {verifyApprovedM11PricingSnapshot}
 from '../src/pricing-policy.js';
import {IntegrationError} from '../src/events.js';

const money=(value:bigint)=>value.toString();
function orderFixture(items:bigint,fulfillment:'pickup'|'delivery'='pickup'){
 const fee=fulfillment==='delivery'?3900n:0n;
 const driver=fulfillment==='delivery'?3200n:0n;
 const tip=fulfillment==='delivery'?500n:0n;
 const quote=quoteOrder({lines:[{unitMinor:items,quantity:1}],
  fulfillment,deliveryFeeMinor:fee,driverBaseMinor:driver,tipMinor:tip});
 const raw={
  currency:'MXN',fulfillment,policyVersion:quote.policyVersion,
  itemsMinor:money(quote.itemsMinor),
  merchantCommissionMinor:money(quote.merchantCommissionMinor),
  merchantPayableMinor:money(quote.merchantPayableMinor),
  serviceFeeMinor:money(quote.serviceFeeMinor),
  deliveryFeeMinor:money(quote.deliveryFeeMinor),
  driverPayableMinor:money(quote.driverPayableMinor),
  tipMinor:money(quote.tipMinor),totalMinor:money(quote.totalMinor),
  platformGrossMinor:money(quote.platformGrossMinor)
 };
 return {raw,orderTotalMinor:raw.totalMinor,fulfillment,
  lines:[{unitMinor:money(items),quantity:1}]};
}
const invalid=(input:Parameters<typeof verifyApprovedM11PricingSnapshot>[0])=>
 assert.throws(()=>verifyApprovedM11PricingSnapshot(input),
  e=>e instanceof IntegrationError&&e.code==='M11_FINANCE_SNAPSHOT_INVALID');

test('owner approved 17% merchant and 7% client service pricing remains intact',()=>{
 assert.equal(PRICING_POLICY_VERSION,'pilot-2026-11-v2-17pct');
 const small=orderFixture(4500n);
 assert.equal(small.raw.merchantCommissionMinor,'765');
 assert.equal(small.raw.merchantPayableMinor,'3735');
 assert.equal(small.raw.serviceFeeMinor,'315');
 assert.equal(small.raw.totalMinor,'4815');
 assert.equal(verifyApprovedM11PricingSnapshot(small).totalMinor,'4815');
 const large=orderFixture(49900n);
 assert.equal(large.raw.merchantCommissionMinor,'8483');
 assert.equal(large.raw.merchantPayableMinor,'41417');
 assert.equal(large.raw.serviceFeeMinor,'2500',
  'preserve existing $25 fee cap pending any separate decision');
 assert.equal(large.raw.totalMinor,'52400');
 assert.equal(verifyApprovedM11PricingSnapshot(large).serviceFeeMinor,'2500');
});

test('delivery and tip are allocated without commission on tip',()=>{
 const input=orderFixture(10000n,'delivery');
 assert.equal(input.raw.merchantCommissionMinor,'1700');
 assert.equal(input.raw.serviceFeeMinor,'700');
 assert.equal(input.raw.driverPayableMinor,'3700');
 assert.equal(input.raw.totalMinor,'15100');
 assert.equal(input.raw.platformGrossMinor,'3100');
 assert.equal(verifyApprovedM11PricingSnapshot(input).fulfillment,'delivery');
});

test('M11 rejects altered fee, commission, payout, total, source lines or pricing version',()=>{
 const f=orderFixture(4500n);
 for(const [field,value] of [
  ['merchantCommissionMinor','764'],
  ['serviceFeeMinor','314'],['merchantPayableMinor','3736'],
  ['platformGrossMinor','1081'],['totalMinor','4816'],
  ['itemsMinor','4501'],['policyVersion','pilot-2026-11-v1-15pct'],
  ['currency','USD']
 ] as const){
  invalid({...f,raw:{...f.raw,[field]:value}});
 }
 invalid({...f,lines:[{unitMinor:'4400',quantity:1}]});
 invalid({...f,lines:[]});
 invalid({...f,lines:[{unitMinor:'4500',quantity:0}]});
 invalid({...f,orderTotalMinor:'4816'});
 invalid({...f,fulfillment:'delivery'});
 invalid({...f,raw:{...f.raw,driverPayableMinor:'1'}});
 invalid({...f,raw:{...f.raw,serviceFeeMinor:'3.15'}});
});
