import test from 'node:test';
import assert from 'node:assert/strict';
import {FinanceError,validateFinancialSnapshot,proposeCaptureJournal} from '../src/ledger.mjs';

const orderId='11111111-1111-4111-8111-111111111111';
const restaurantId='22222222-2222-4222-8222-222222222222';
const driverId='33333333-3333-4333-8333-333333333333';
const evidence={sourceSystem:'stripe_test',kind:'capture_verified',
  eventId:'evt_test_1234567890'};
const snap={
  currency:'MXN',policyVersion:'pilot-contract-pending',fulfillment:'delivery',
  itemsMinor:'25000',merchantCommissionMinor:'3750',merchantPayableMinor:'21250',
  serviceFeeMinor:'1750',deliveryFeeMinor:'3900',driverPayableMinor:'3200',
  tipMinor:'0',totalMinor:'30650',platformGrossMinor:'6200'
};
const capture=(override={})=>proposeCaptureJournal({
  orderId,restaurantId,driverId,snapshot:snap,evidence,...override});
const reject=(fn,code)=>assert.throws(fn,e=>e instanceof FinanceError&&e.code===code);

test('journal is balanced in integer centavos, MXN, no transfer side effects',()=>{
  const j=capture();
  assert.equal(j.currency,'MXN');
  assert.equal(j.lines.length,4);
  assert.equal(j.sourceSystem,'stripe_test');
  assert.equal(j.lines.filter(x=>x.side==='debit').reduce((n,x)=>n+BigInt(x.amountMinor),0n),
    j.lines.filter(x=>x.side==='credit').reduce((n,x)=>n+BigInt(x.amountMinor),0n));
  assert.equal(j.lines.find(x=>x.accountCode==='liability.merchant_pending').amountMinor,'21250');
  assert.equal(j.lines.find(x=>x.accountCode==='liability.driver_held').amountMinor,'3200');
  assert.equal(j.lines.find(x=>x.accountCode==='liability.platform_pending').amountMinor,'6200');
});
test('deterministic idempotency fingerprint for equal payload',()=>{
  assert.equal(capture().snapshotHash,capture().snapshotHash);
  assert.notEqual(capture().snapshotHash,capture({evidence:{...evidence,eventId:'evt_test_other123'}}).snapshotHash);
  assert.notEqual(capture().snapshotHash,capture({snapshot:{...snap,policyVersion:'other-policy'}}).snapshotHash);
});
test('reject negative, decimal, leading zeros and large money strings',()=>{
  for(const invalid of ['-1','3.14','01',15,NaN,'1000000000001']){
    reject(()=>validateFinancialSnapshot({...snap,serviceFeeMinor:invalid}),'MONEY_FORMAT_INVALID'===(
      typeof invalid==='string'&&invalid==='1000000000001'?'MONEY_OUT_OF_RANGE':'MONEY_FORMAT_INVALID')
      ? 'MONEY_FORMAT_INVALID':'MONEY_OUT_OF_RANGE');
  }
});
test('reject inaccurate merchant share',()=>reject(()=>
  capture({snapshot:{...snap,merchantPayableMinor:'22000'}}),'MERCHANT_BALANCE_INVALID'));
test('reject mismatched customer total',()=>reject(()=>
  capture({snapshot:{...snap,totalMinor:'30649'}}),'CUSTOMER_TOTAL_INVALID'));
test('reject negative net platform disguised by payouts',()=>reject(()=>
  capture({snapshot:{...snap,driverPayableMinor:'10000'}}),'PAYOUT_BALANCE_INVALID'));
test('reject pickup with delivery income',()=>reject(()=>
  capture({snapshot:{...snap,fulfillment:'pickup'}}),'PICKUP_FINANCE_INVALID'));
test('holds courier share at capture even without a selected driver',()=>{
  const j=capture({driverId:null});
  assert.equal(j.lines.find(x=>x.accountCode==='liability.driver_held').amountMinor,'3200');
  assert.equal(j.lines.some(x=>x.accountCode==='liability.driver_payable'),false);
  assert.equal(j.lines.some(x=>x.accountCode==='income.platform_gross'),false);
  assert.equal(j.lines.some(x=>x.partyId===driverId),false);
});
test('reject invalid driver IDs',()=>reject(()=>
  capture({driverId:'invalid'}),'DRIVER_ID_INVALID'));
test('reject invalid order or merchant UUID',()=>reject(()=>
  capture({orderId:'forged'}),'ACTOR_ID_INVALID'));
test('reject live or unverified provider evidence',()=>{
  reject(()=>capture({evidence:{...evidence,sourceSystem:'stripe_live'}}),'EVIDENCE_INVALID');
  reject(()=>capture({evidence:{...evidence,kind:'payment_intent_created'}}),'EVIDENCE_INVALID');
});
test('valid pickup proposal has no driver liability',()=>{
  const pickup={...snap,fulfillment:'pickup',deliveryFeeMinor:'0',driverPayableMinor:'0',
    totalMinor:'26750',platformGrossMinor:'5500'};
  const j=capture({snapshot:pickup,driverId:null});
  assert.equal(j.lines.some(x=>x.accountCode==='liability.driver_held'),false);
  assert.equal(j.lines.length,3);
});
test('pickup amounts remain held until a separate fulfillment gate',()=>{
  const pickup={...snap,fulfillment:'pickup',deliveryFeeMinor:'0',driverPayableMinor:'0',
    totalMinor:'26750',platformGrossMinor:'5500'};
  const j=capture({snapshot:pickup,driverId:null});
  assert.equal(j.lines.some(x=>x.accountCode==='liability.driver_held'),false);
  assert.equal(j.lines.find(x=>x.accountCode==='liability.platform_pending').amountMinor,'5500');
});
test('proposal output is immutable and uses no floating point',()=>{
  const j=capture();
  assert.equal(Object.isFrozen(j.lines),true);
  assert.equal(Object.isFrozen(j.lines[0]),true);
  assert.equal(typeof j.lines[0].amountMinor,'string');
});
