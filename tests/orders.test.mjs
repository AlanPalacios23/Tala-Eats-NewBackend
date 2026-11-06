import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionOrder, OrderTransitionError } from '../src/modules/orders/order-machine.ts';
import { quoteOrder, PRICING_POLICY_VERSION } from '../src/modules/orders/pricing.ts';

const base = {
  current: 'received',
  target: 'confirmed',
  fulfillment: 'delivery',
  paymentMethod: 'cash',
  actor: 'merchant'
};
function expectCode(fn, code) {
  assert.throws(fn, (err) => err instanceof OrderTransitionError && err.code === code);
}

test('merchant accepts a received order', () => {
  assert.equal(transitionOrder(base), 'confirmed');
});
test('driver cannot accept as merchant', () => {
  expectCode(() => transitionOrder({...base,actor:'driver'}), 'ACTOR_FORBIDDEN');
});
test('no jumping from received to ready', () => {
  expectCode(() => transitionOrder({...base,target:'ready'}), 'TRANSITION_FORBIDDEN');
});
test('Stripe requires verified provider payment before received', () => {
  expectCode(() => transitionOrder({
    ...base,current:'awaiting_payment',target:'received',
    paymentMethod:'stripe',actor:'system'
  }), 'PAYMENT_VERIFICATION_REQUIRED');
});
test('Stripe trusted payment evidence allows receiving', () => {
  assert.equal(transitionOrder({
    ...base,current:'awaiting_payment',target:'received',
    paymentMethod:'stripe',paymentVerified:true,actor:'system'
  }), 'received');
});
test('cash order may be received pending physical payment', () => {
  assert.equal(transitionOrder({
    ...base,current:'awaiting_payment',target:'received',actor:'system'
  }), 'received');
});
test('no cancellation without compensated stock/money', () => {
  expectCode(() => transitionOrder({
    ...base,target:'cancelled'
  }), 'CANCELLATION_COMPENSATION_REQUIRED');
});
test('merchant can cancel received order with compensation', () => {
  assert.equal(transitionOrder({
    ...base,target:'cancelled',cancellationCleared:true
  }), 'cancelled');
});
test('pickup has no courier assignment', () => {
  expectCode(() => transitionOrder({
    ...base,current:'ready',target:'assigned',actor:'system',fulfillment:'pickup'
  }), 'PICKUP_HAS_NO_DRIVER');
});
test('pickup requires both payment and handoff evidence', () => {
  expectCode(() => transitionOrder({
    ...base,current:'ready',target:'delivered',fulfillment:'pickup',
    paymentVerified:true
  }), 'PICKUP_PROOF_REQUIRED');
  assert.equal(transitionOrder({
    ...base,current:'ready',target:'delivered',fulfillment:'pickup',
    paymentVerified:true,pickupProofVerified:true
  }), 'delivered');
});
test('delivery cannot complete without a verified PIN and payment', () => {
  expectCode(() => transitionOrder({
    ...base,current:'on_the_way',target:'delivered',actor:'driver',
    paymentVerified:true
  }), 'DELIVERY_PIN_REQUIRED');
  expectCode(() => transitionOrder({
    ...base,current:'on_the_way',target:'delivered',actor:'driver',
    deliveryPinVerified:true
  }), 'PAYMENT_VERIFICATION_REQUIRED');
  assert.equal(transitionOrder({
    ...base,current:'on_the_way',target:'delivered',actor:'driver',
    deliveryPinVerified:true,paymentVerified:true
  }), 'delivered');
});
test('reassignment requires explicit authorization', () => {
  expectCode(() => transitionOrder({
    ...base,current:'assigned',target:'ready',actor:'system'
  }), 'REASSIGNMENT_PROOF_REQUIRED');
});
test('terminal states cannot transition', () => {
  expectCode(() => transitionOrder({
    ...base,current:'delivered',target:'received'
  }), 'TRANSITION_FORBIDDEN');
  expectCode(() => transitionOrder({
    ...base,current:'cancelled',target:'received'
  }), 'TRANSITION_FORBIDDEN');
});
test('17% / 7% + delivery quote uses integer centavos', () => {
  const q = quoteOrder({
    lines:[{unitMinor:20000n,quantity:1}],
    fulfillment:'delivery',deliveryFeeMinor:3900n,driverBaseMinor:3200n,tipMinor:0n
  });
  assert.equal(q.itemsMinor,20000n);
  assert.equal(q.merchantCommissionMinor,3400n);
  assert.equal(q.serviceFeeMinor,1400n);
  assert.equal(q.merchantPayableMinor,16600n);
  assert.equal(q.driverPayableMinor,3200n);
  assert.equal(q.totalMinor,25300n);
  assert.equal(q.platformGrossMinor,5500n);
  assert.equal(q.policyVersion,PRICING_POLICY_VERSION);
});
test('service fee remains 7% on high-value orders without hidden cap', () => {
  const q = quoteOrder({
    lines:[{unitMinor:50000n,quantity:1}],
    fulfillment:'pickup',deliveryFeeMinor:0n,driverBaseMinor:0n,tipMinor:0n
  });
  assert.equal(q.serviceFeeMinor,3500n);
  assert.equal(q.totalMinor,53500n);
  assert.equal(q.platformGrossMinor,12000n);
  assert.equal(q.merchantCommissionMinor,8500n);
});
test('tips do not inflate platform gross revenue', () => {
  const q = quoteOrder({
    lines:[{unitMinor:20000n,quantity:1}],
    fulfillment:'delivery',deliveryFeeMinor:3900n,driverBaseMinor:3200n,tipMinor:500n
  });
  assert.equal(q.totalMinor,25800n);
  assert.equal(q.driverPayableMinor,3700n);
  assert.equal(q.platformGrossMinor,5500n);
});
test('pickup refuses courier wages and delivery charges', () => {
  assert.throws(() => quoteOrder({
    lines:[{unitMinor:20000n,quantity:1}],
    fulfillment:'pickup',deliveryFeeMinor:3900n,driverBaseMinor:0n,tipMinor:0n
  }),/PICKUP_LOGISTICS_INVALID/);
});
test('invalid money/quantity cannot be priced', () => {
  assert.throws(() => quoteOrder({
    lines:[{unitMinor:-1n,quantity:1}],
    fulfillment:'pickup',deliveryFeeMinor:0n,driverBaseMinor:0n,tipMinor:0n
  }),/LINE_INVALID/);
  assert.throws(() => quoteOrder({
    lines:[{unitMinor:20000n,quantity:0}],
    fulfillment:'pickup',deliveryFeeMinor:0n,driverBaseMinor:0n,tipMinor:0n
  }),/LINE_INVALID/);
});
