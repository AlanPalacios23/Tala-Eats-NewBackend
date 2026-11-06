/** Cross-domain, NO-DB financial contract validation against REAL M1/M3 code.
 * These are approval regression tests, NOT proof of payment or settlement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteOrder,PRICING_POLICY_VERSION}
 from '../../../src/modules/orders/pricing.js';
import {validateFinancialSnapshot,proposeHeldAllocation}
 // @ts-expect-error M3 intentionally exports pure JS without TypeScript types
 from '../../finance/src/ledger.mjs';

const fields=['itemsMinor','merchantCommissionMinor','merchantPayableMinor',
 'serviceFeeMinor','deliveryFeeMinor','driverPayableMinor','tipMinor',
 'totalMinor','platformGrossMinor'] as const;
const id='129a9ba5-5dda-4bdb-82d8-19bac483e7e1';
const merchant='219a9ba5-5dda-4bdb-82d8-19bac483e7e1';
function snapshot(q:ReturnType<typeof quoteOrder>,fulfillment:'pickup'|'delivery'){
 return {currency:'MXN',policyVersion:q.policyVersion,fulfillment,
  ...Object.fromEntries(fields.map(k=>[k,q[k].toString()]))};
}
test('M1 17% merchant and 7% customer, M3 balanced HELD pickup ledger',()=>{
 const q=quoteOrder({lines:[{unitMinor:10000n,quantity:1}],
  fulfillment:'pickup',deliveryFeeMinor:0n,driverBaseMinor:0n,tipMinor:0n});
 assert.equal(q.policyVersion,PRICING_POLICY_VERSION);
 assert.equal(q.merchantCommissionMinor,1700n);
 assert.equal(q.serviceFeeMinor,700n);
 assert.equal(q.merchantPayableMinor,8300n);
 assert.equal(q.totalMinor,10700n);
 assert.equal(q.platformGrossMinor,2400n);
 const journal=proposeHeldAllocation({orderId:id,restaurantId:merchant,
  snapshot:snapshot(q,'pickup'),commandKey:'m11-lab9-pricing-pickup-v1'});
 assert.equal(journal.kind,'allocation_held');
 assert.equal(journal.lines.filter((x:{side:string})=>x.side==='debit')
  .reduce((a:bigint,x:{amountMinor:string})=>a+BigInt(x.amountMinor),0n),10700n);
 assert.equal(journal.lines.filter((x:{side:string})=>x.side==='credit')
  .reduce((a:bigint,x:{amountMinor:string})=>a+BigInt(x.amountMinor),0n),10700n);
 assert.deepEqual(journal.snapshot,validateFinancialSnapshot(snapshot(q,'pickup')));
});
test('M1 delivery 17/7 + delivery $39 + driver $32 + tip $5, M3 HELD',()=>{
 const q=quoteOrder({lines:[{unitMinor:10000n,quantity:1}],
  fulfillment:'delivery',deliveryFeeMinor:3900n,driverBaseMinor:3200n,
  tipMinor:500n});
 assert.equal(q.merchantCommissionMinor,1700n);
 assert.equal(q.serviceFeeMinor,700n);
 assert.equal(q.merchantPayableMinor,8300n);
 assert.equal(q.driverPayableMinor,3700n);
 assert.equal(q.totalMinor,15100n);
 assert.equal(q.platformGrossMinor,3100n);
 const held=proposeHeldAllocation({orderId:id,restaurantId:merchant,
  snapshot:snapshot(q,'delivery'),commandKey:'m11-lab9-pricing-delivery-v1'});
 assert.ok(held.lines.some((x:{accountCode:string,amountMinor:string})=>
  x.accountCode==='liability.delivery_held'&&x.amountMinor==='3700'));
 assert.ok(!held.lines.some((x:{accountCode:string})=>
  x.accountCode.includes('withdrawable')));
});
test('Release pricing enforces uncapped 7% above $357.14',()=>{
 const q=quoteOrder({lines:[{unitMinor:50000n,quantity:1}],
  fulfillment:'pickup',deliveryFeeMinor:0n,driverBaseMinor:0n,tipMinor:0n});
 assert.equal(q.merchantCommissionMinor,8500n);
 assert.equal(q.serviceFeeMinor,3500n);
 assert.equal(q.merchantPayableMinor,41500n);
 assert.equal(q.totalMinor,53500n);
 assert.equal(q.platformGrossMinor,12000n);
 const proposed=proposeHeldAllocation({orderId:id,restaurantId:merchant,
  snapshot:snapshot(q,'pickup'),commandKey:'m11-rc1-large-basket-ledger'});
 assert.equal(proposed.snapshot.serviceFeeMinor,'3500');
});
