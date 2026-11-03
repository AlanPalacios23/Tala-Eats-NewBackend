import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {FinanceError} from '../src/ledger.mjs';
import {sha256} from '../src/stripe-test-webhook.mjs';
import {registerTestIntent,recordSignedTestCapture} from '../src/store.mjs';
import {reconcileTestFinances} from '../src/reconciliation.mjs';

const url=process.env.FINANCE_CI_URL??'';
const enabled=/\/tala_finance_v2_test(?:$|\?)/.test(url);
const secret='whsec_reconciliation_lab_123456789000';
const uuid=()=>randomUUID();
const pi=()=> 'pi_lab_'+uuid().replaceAll('-','');
const evt=()=> 'evt_lab_'+uuid().replaceAll('-','');
const snap=Object.freeze({
  currency:'MXN',policyVersion:'lab-only-policy-contract',
  fulfillment:'delivery',itemsMinor:'25000',
  merchantCommissionMinor:'3750',merchantPayableMinor:'21250',
  serviceFeeMinor:'1750',deliveryFeeMinor:'3900',driverPayableMinor:'3200',
  tipMinor:'0',totalMinor:'30650',platformGrossMinor:'6200'
});
function signed(intent,eventId){
  const rawBody=Buffer.from(JSON.stringify({
    id:eventId,livemode:false,type:'payment_intent.succeeded',
    data:{object:{id:intent,object:'payment_intent',status:'succeeded',
      currency:'mxn',amount:30650,amount_received:30650}}
  }));
  const timestamp=Math.floor(Date.now()/1000);
  const h=createHmac('sha256',secret).update(String(timestamp))
    .update('.').update(rawBody).digest('hex');
  return {rawBody,signatureHeader:'t='+timestamp+',v1='+h,webhookSecret:secret};
}
test('M3 read-only reconciliation: pending, held, mismatch, orphan, and non-PII',
  {skip:!enabled,timeout:70000},async()=>{
  const pool=new Pool({connectionString:url,max:10});
  const merchant=uuid();
  const pending=uuid(),captured=uuid(),forged=uuid(),orphan=uuid(),
    badContract=uuid(),badMath=uuid();
  try{
    const register=(orderId,paymentIntentId)=>registerTestIntent(pool,{
      orderId,restaurantId:merchant,driverId:null,paymentIntentId,snapshot:snap});
    await register(pending,pi());
    const actualIntent=pi(),eventId=evt();
    await register(captured,actualIntent);
    await recordSignedTestCapture(pool,signed(actualIntent,eventId));
    const forgedPi=pi();
    await register(forged,forgedPi);
    // Legal by the journal schema, but illegal at the business level:
    // direct SQL created a nonmatching amount without a signed receipt.
    const lines=JSON.stringify([
      {accountCode:'asset.stripe_test_clearing',side:'debit',amountMinor:'100'},
      {accountCode:'liability.merchant_pending',side:'credit',
        partyId:merchant,amountMinor:'80'},
      {accountCode:'liability.platform_pending',side:'credit',amountMinor:'20'}
    ]);
    await pool.query(`
      INSERT INTO tala_finance_v2.journals
      (order_id,kind,source_system,source_event_id,snapshot_hash,lines)
      VALUES($1::uuid,'capture','stripe_test',$2,$3,$4::jsonb)`,
      [forged,evt(),'a'.repeat(64),lines]);
    await pool.query(`
      INSERT INTO tala_finance_v2.journals
      (order_id,kind,source_system,source_event_id,snapshot_hash,lines)
      VALUES($1::uuid,'capture','stripe_test',$2,$3,$4::jsonb)`,
      [orphan,evt(),'b'.repeat(64),lines]);
    // A rogue SQL client can INSERT a mismatched contract hash, which
    // must never be counted as a healthy pending intent.
    await pool.query(`
      INSERT INTO tala_finance_v2.test_intents
      (order_id,restaurant_id,driver_id,payment_intent_id,snapshot,contract_hash,expected_minor)
      VALUES($1::uuid,$2::uuid,NULL,$3,$4::jsonb,$5,30650)`,
      [badContract,merchant,pi(),JSON.stringify(snap),'f'.repeat(64)]);
    // Malformed accounting values with a CORRECT recomputed contract hash
    // must still be rejected by arithmetic validation.
    const badPI=pi(),badSnapshot={...snap,serviceFeeMinor:'2000'};
    const fields=['itemsMinor','merchantCommissionMinor','merchantPayableMinor',
      'serviceFeeMinor','deliveryFeeMinor','driverPayableMinor','tipMinor',
      'totalMinor','platformGrossMinor'];
    const hash=sha256(Buffer.from(JSON.stringify([
      badMath,merchant,null,badPI,badSnapshot.currency,badSnapshot.policyVersion,
      badSnapshot.fulfillment,...fields.map(k=>badSnapshot[k])
    ])));
    await pool.query(`
      INSERT INTO tala_finance_v2.test_intents
      (order_id,restaurant_id,driver_id,payment_intent_id,snapshot,contract_hash,expected_minor)
      VALUES($1::uuid,$2::uuid,NULL,$3,$4::jsonb,$5,30650)`,
      [badMath,merchant,badPI,JSON.stringify(badSnapshot),hash]);
    const report=await reconcileTestFinances(pool,{
      orderIds:[pending,captured,forged,orphan,badContract,badMath],limit:10
    });
    assert.equal(report.providerReconciled,false);
    assert.equal(report.scope,'explicit_orders');
    assert.equal(report.examined,5);
    assert.equal(report.awaitingPayment,1);
    assert.equal(report.capturedHeld,1);
    assert.equal(report.needsReview,4);
    assert.deepEqual(report.orphanJournalOrderIds,[orphan]);
    const byId=Object.fromEntries(report.orders.map(row=>[row.orderId,row]));
    assert.equal(byId[pending].state,'awaiting_payment');
    assert.equal(byId[captured].state,'captured_held');
    assert.equal(byId[captured].capturedMinor,'30650');
    assert.deepEqual(byId[captured].reasons,[]);
    assert.equal(byId[forged].state,'needs_review');
    assert.ok(byId[forged].reasons.includes('JOURNAL_WITHOUT_RECEIPT'));
    assert.ok(byId[forged].reasons.includes('CAPTURE_AMOUNT_MISMATCH'));
    assert.ok(byId[forged].reasons.includes('MERCHANT_ALLOCATION_MISMATCH'));
    assert.deepEqual(byId[badContract].reasons,['INTENT_CONTRACT_INVALID']);
    assert.deepEqual(byId[badMath].reasons,['INTENT_CONTRACT_INVALID']);
    assert.equal(JSON.stringify(report).includes('webhookSecret'),false);
    assert.equal(JSON.stringify(report).includes('rawBody'),false);
    assert.ok(Object.isFrozen(report.orders));
    assert.ok(Object.isFrozen(report.orders[0]));
    assert.ok(Object.isFrozen(report.orders[0].reasons));
    const after=await pool.query(`
      SELECT count(*)::int AS n FROM tala_finance_v2.journals
      WHERE order_id=ANY($1::uuid[])`,[[pending,captured,forged,orphan,badContract,badMath]]);
    assert.equal(after.rows[0].n,3,'read-only reconciliation must not post');
    // Input validation and DB-level isolation are explicit fail-closed gates.
    await assert.rejects(reconcileTestFinances(pool,{limit:0}),
      e=>e instanceof FinanceError&&e.code==='RECONCILIATION_LIMIT_INVALID');
    await assert.rejects(reconcileTestFinances(pool,{orderIds:['arbitrary']}),
      e=>e instanceof FinanceError&&e.code==='RECONCILIATION_SCOPE_INVALID');
    await assert.rejects(reconcileTestFinances(pool,{orderIds:[]}),
      e=>e instanceof FinanceError&&e.code==='RECONCILIATION_SCOPE_INVALID');
  }finally{await pool.end();}
});
