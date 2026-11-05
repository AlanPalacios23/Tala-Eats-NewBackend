import test from 'node:test';
import assert from 'node:assert/strict';
import {FinanceError,validateFinancialSnapshot,proposeHeldAllocation,
  proposeFullHeldReversal,financeSnapshotHash} from '../src/ledger.mjs';

export const orderId='11111111-1111-4111-8111-111111111111';
export const restaurantId='22222222-2222-4222-8222-222222222222';
export const snap={
  currency:'MXN',policyVersion:'pilot-contract-pending',fulfillment:'delivery',
  itemsMinor:'25000',merchantCommissionMinor:'3750',merchantPayableMinor:'21250',
  serviceFeeMinor:'1750',deliveryFeeMinor:'3900',driverPayableMinor:'3200',
  tipMinor:'0',totalMinor:'30650',platformGrossMinor:'6200'
};
const proposal=(override={})=>proposeHeldAllocation({
  orderId,restaurantId,snapshot:snap,
  commandKey:'finance-lab-command-000001',...override
});
const reject=(fn,code)=>assert.throws(fn,e=>
  e instanceof FinanceError&&e.code===code);

test('finance-only ledger is provider-neutral; holds every allocation',()=>{
  const p=proposal();
  assert.equal(p.kind,'allocation_held');
  assert.equal(p.currency,'MXN');
  assert.equal(p.lines.length,4);
  assert.deepEqual(p.lines.map(x=>x.accountCode),[
    'asset.external_clearing_pending',
    'liability.merchant_pending',
    'liability.delivery_held',
    'liability.platform_pending'
  ]);
  assert.equal(p.lines.find(x=>x.accountCode==='liability.delivery_held').partyId,undefined);
  assert.equal(p.lines.some(x=>/available|stripe|revenue|payable/.test(x.accountCode)),false);
  const debit=p.lines.filter(x=>x.side==='debit')
    .reduce((n,x)=>n+BigInt(x.amountMinor),0n);
  const credit=p.lines.filter(x=>x.side==='credit')
    .reduce((n,x)=>n+BigInt(x.amountMinor),0n);
  assert.equal(debit,credit);
  assert.equal(credit,30650n);
});
test('same command yields deterministic idempotency hash',()=>{
  assert.equal(proposal().eventKey,proposal().eventKey);
  assert.notEqual(proposal().eventKey,
    proposal({commandKey:'finance-lab-command-000002'}).eventKey);
  assert.notEqual(proposal().snapshotHash,
    proposal({snapshot:{...snap,policyVersion:'other-policy'}}).snapshotHash);
  assert.equal(proposal().snapshotHash,financeSnapshotHash(orderId,restaurantId,snap));
});
test('detects merchant share arithmetic error',()=>reject(()=>
  proposal({snapshot:{...snap,merchantPayableMinor:'22000'}}),
  'FINANCE_MERCHANT_SHARE_INVALID'));
test('detects total arithmetic error',()=>reject(()=>
  proposal({snapshot:{...snap,totalMinor:'30649'}}),
  'FINANCE_CUSTOMER_TOTAL_INVALID'));
test('detects impossible allocations',()=>reject(()=>
  proposal({snapshot:{...snap,driverPayableMinor:'9000'}}),
  'FINANCE_ALLOCATION_INVALID'));
test('rejects extra fields in a financial contract',()=>reject(()=>
  proposal({snapshot:{...snap,stripePaymentIntentId:'pi_not_allowed'}}),
  'FINANCE_SNAPSHOT_INVALID'));
test('rejects missing snapshot fields',()=>reject(()=>{
  const v={...snap};delete v.platformGrossMinor;
  proposal({snapshot:v});
},'FINANCE_SNAPSHOT_INVALID'));
test('rejects unsafe centavo types, negative, decimals and zeros with padding',()=>{
  for(const bad of [-1,'-1','3.14',10,'01',null]){
    reject(()=>validateFinancialSnapshot({...snap,serviceFeeMinor:bad}),
      'FINANCE_MONEY_INVALID');
  }
});
test('rejects centavos beyond maximum',()=>reject(()=>
  proposal({snapshot:{...snap,itemsMinor:'1000000000001'}}),
  'FINANCE_MONEY_OUT_OF_RANGE'));
test('pickup has no courier or delivery allocation',()=>{
  const pickup={...snap,fulfillment:'pickup',deliveryFeeMinor:'0',
    driverPayableMinor:'0',tipMinor:'0',totalMinor:'26750',
    platformGrossMinor:'5500'};
  const p=proposal({snapshot:pickup});
  assert.equal(p.lines.length,3);
  assert.equal(p.lines.some(x=>x.accountCode==='liability.delivery_held'),false);
  assert.equal(p.lines.find(x=>x.accountCode==='liability.merchant_pending')
    .amountMinor,'21250');
});
test('pickup cannot include delivery or tip',()=>reject(()=>
  proposal({snapshot:{...snap,fulfillment:'pickup'}}),
  'FINANCE_PICKUP_INVALID'));
test('delivery must have a nonzero logistics allocation',()=>reject(()=>
  proposal({snapshot:{...snap,driverPayableMinor:'0',platformGrossMinor:'9400'}}),
  'FINANCE_DELIVERY_INVALID'));
test('strict order and restaurant identity',()=>reject(()=>
  proposal({restaurantId:'not-uuid'}),'FINANCE_ID_INVALID'));
test('strict command idempotency key',()=>reject(()=>
  proposal({commandKey:'short'}),'FINANCE_COMMAND_INVALID'));
test('immutable proposal cannot be mutated after construction',()=>{
  const p=proposal();
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.lines));
  assert.ok(Object.isFrozen(p.snapshot));
  assert.ok(p.lines.every(Object.isFrozen));
});


test('full correction is the exact inverse of held allocation, not a refund',()=>{
  const original=proposal();
  const rev=proposeFullHeldReversal({
    originalJournalId:'33333333-3333-4333-8333-333333333333',
    orderId,restaurantId,snapshot:snap,snapshotHash:original.snapshotHash,
    originalLines:original.lines,
    commandKey:'finance-correction-command-000001'
  });
  assert.equal(rev.kind,'full_held_reversal');
  assert.equal(rev.currency,'MXN');
  assert.equal(rev.lines.length,original.lines.length);
  assert.ok(rev.lines.every((line,i)=>
    line.amountMinor===original.lines[i].amountMinor&&
    line.accountCode===original.lines[i].accountCode&&
    line.side!==original.lines[i].side));
  assert.equal(new Set(rev.lines.map(x=>x.accountCode)).size,rev.lines.length);
  assert.ok(Object.isFrozen(rev.lines));
  assert.ok(rev.lines.every(Object.isFrozen));
  assert.equal(rev.eventKey,proposeFullHeldReversal({
    originalJournalId:'33333333-3333-4333-8333-333333333333',
    orderId,restaurantId,snapshot:snap,snapshotHash:original.snapshotHash,
    originalLines:original.lines,
    commandKey:'finance-correction-command-000001'
  }).eventKey);
});

test('reversal rejects forged base journal contents and snapshot hash',()=>{
  const original=proposal();
  const input={
    originalJournalId:'33333333-3333-4333-8333-333333333333',
    orderId,restaurantId,snapshot:snap,snapshotHash:original.snapshotHash,
    originalLines:original.lines,commandKey:'finance-correction-command-000001'
  };
  reject(()=>proposeFullHeldReversal({...input,snapshotHash:'a'.repeat(64)}),
    'FINANCE_BASE_JOURNAL_INVALID');
  const broken=original.lines.map(x=>({...x}));
  broken[0].amountMinor='1';
  reject(()=>proposeFullHeldReversal({...input,originalLines:broken}),
    'FINANCE_BASE_JOURNAL_INVALID');
  reject(()=>proposeFullHeldReversal({...input,commandKey:'bad'}),
    'FINANCE_COMMAND_INVALID');
});
