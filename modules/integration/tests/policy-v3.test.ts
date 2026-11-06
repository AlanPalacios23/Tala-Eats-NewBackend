/** Financial boundary regression: all accepted facts originate in REAL M1
 * quoteOrder, M11 independently checks them before M3 / M8 side effects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteOrder,PRICING_POLICY_VERSION}
 from '../../../src/modules/orders/pricing.js';
import {IntegrationError} from '../src/events.js';
import {APPROVED_POLICY_V3,requireApprovedV3Snapshot}
 from '../src/policy-v3.js';

const money=['itemsMinor','merchantCommissionMinor','merchantPayableMinor',
 'serviceFeeMinor','deliveryFeeMinor','driverPayableMinor','tipMinor',
 'totalMinor','platformGrossMinor'] as const;
type Fulfillment='pickup'|'delivery';
function priced(subtotal:bigint,fulfillment:Fulfillment='pickup',tip=0n){
 const delivery=fulfillment==='delivery';
 const q=quoteOrder({lines:[{unitMinor:subtotal,quantity:1}],fulfillment,
  deliveryFeeMinor:delivery?3900n:0n,
  driverBaseMinor:delivery?3200n:0n,tipMinor:tip});
 const source={policyVersion:q.policyVersion,
  ...Object.fromEntries(money.map(key=>[key,q[key].toString()])),
  lines:[{productId:'not-sensitive',quantity:1}]};
 return {q,source};
}
const deny=(snapshot:unknown,fulfillment:Fulfillment,total:string)=>
 assert.throws(()=>requireApprovedV3Snapshot(snapshot,fulfillment,total),
  err=>err instanceof IntegrationError&&
  err.code==='M11_PRICING_POLICY_MISMATCH');

test('new version explicit, no reuse of capped v2 historical policy',()=>{
 assert.equal(PRICING_POLICY_VERSION,APPROVED_POLICY_V3);
 const {q,source}=priced(50000n);
 assert.equal(q.merchantCommissionMinor,8500n);
 assert.equal(q.serviceFeeMinor,3500n);
 const snapshot=requireApprovedV3Snapshot(source,'pickup',q.totalMinor.toString());
 assert.equal(snapshot.serviceFeeMinor,'3500');
 deny({...source,policyVersion:'pilot-2026-11-v2-17pct'},'pickup',
  q.totalMinor.toString());
});
test('M1↔M11 integer-cents exact parity across small, middle and large carts',()=>{
 for(const subtotal of [1n,2n,3n,9n,10n,99n,100n,101n,999n,
  35714n,35715n,50000n,199999n,500000n]){
  const {q,source}=priced(subtotal);
  const canonical=requireApprovedV3Snapshot(source,'pickup',q.totalMinor.toString());
  assert.equal(canonical.merchantCommissionMinor,q.merchantCommissionMinor.toString());
  assert.equal(canonical.serviceFeeMinor,q.serviceFeeMinor.toString());
  assert.equal(canonical.totalMinor,q.totalMinor.toString());
 }
});
test('tip is credited in full to courier without increasing platform margin',()=>{
 const without=priced(50000n,'delivery');
 const withTip=priced(50000n,'delivery',1500n);
 assert.equal(withTip.q.merchantCommissionMinor,without.q.merchantCommissionMinor);
 assert.equal(withTip.q.serviceFeeMinor,without.q.serviceFeeMinor);
 assert.equal(withTip.q.platformGrossMinor,without.q.platformGrossMinor);
 assert.equal(withTip.q.driverPayableMinor-without.q.driverPayableMinor,1500n);
 assert.equal(withTip.q.totalMinor-without.q.totalMinor,1500n);
 const approved=requireApprovedV3Snapshot(withTip.source,'delivery',
  withTip.q.totalMinor.toString());
 assert.equal(approved.driverPayableMinor,'4700');
});
test('tampered commission, 7% service, merchant, driver, or platform fails closed',()=>{
 const {q,source}=priced(50000n,'delivery',500n);
 const total=q.totalMinor.toString();
 for(const [key,next] of [
  ['merchantCommissionMinor','0'],['merchantCommissionMinor','7500'],
  ['serviceFeeMinor','2500'],['serviceFeeMinor','0'],
  ['merchantPayableMinor','50000'],['driverPayableMinor','500'],
  ['tipMinor','0'],['totalMinor','0'],['platformGrossMinor','1'],
  ['deliveryFeeMinor','0'],['itemsMinor','-1'],
  ['itemsMinor','NaN'],['itemsMinor','01']
 ]){
  deny({...source,[key]:next},'delivery',total);
 }
 deny(source,'pickup',total);
 deny(source,'delivery','0');
 deny(null,'delivery',total);
 deny({},'delivery',total);
});
