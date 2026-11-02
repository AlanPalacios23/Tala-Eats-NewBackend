import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {Pool} from 'pg';
import {FinanceError} from '../src/ledger.mjs';
import {registerTestIntent,recordSignedTestCapture} from '../src/store.mjs';

const url=process.env.FINANCE_CI_URL??'';
const enabled=/\/tala_finance_v2_test(?:$|\?)/.test(url);
const secret='whsec_ci_fake_test_secret_1234567890';
const snap={
  currency:'MXN',policyVersion:'lab-only-policy-contract',
  fulfillment:'delivery',itemsMinor:'25000',
  merchantCommissionMinor:'3750',merchantPayableMinor:'21250',
  serviceFeeMinor:'1750',deliveryFeeMinor:'3900',driverPayableMinor:'3200',
  tipMinor:'0',totalMinor:'30650',platformGrossMinor:'6200'
};
const sign=(raw)=>{
  const ts=Math.floor(Date.now()/1000);
  return 't='+ts+',v1='+createHmac('sha256',secret)
    .update(String(ts)).update('.').update(raw).digest('hex');
};
const event=(pi,id,minor=30650)=>{
  const raw=Buffer.from(JSON.stringify({
    id,livemode:false,type:'payment_intent.succeeded',
    data:{object:{id:pi,object:'payment_intent',currency:'mxn',status:'succeeded',
      amount:minor,amount_received:minor}}
  }));
  return {rawBody:raw,signatureHeader:sign(raw),webhookSecret:secret};
};
const fail=async(fn,code)=>assert.rejects(fn,e=>e instanceof FinanceError&&e.code===code);

test('M3 isolated SQL: trusted contract, signed capture, replay, concurrency, and denial',
  {skip:!enabled,timeout:70000},async()=>{
    const pool=new Pool({connectionString:url,max:12,connectionTimeoutMillis:3000});
    try{
      const restaurantId=randomUUID(),driverId=randomUUID(),
        orderId=randomUUID(),paymentIntentId='pi_lab_'+randomUUID().replaceAll('-',''),
        eventId='evt_lab_'+randomUUID().replaceAll('-','');
      const registration={orderId,restaurantId,driverId,paymentIntentId,snapshot:snap};
      assert.deepEqual(await registerTestIntent(pool,registration),
        {orderId,replayed:false});
      assert.deepEqual(await registerTestIntent(pool,registration),
        {orderId,replayed:true});
      await fail(()=>registerTestIntent(pool,{...registration,
        snapshot:{...snap,merchantPayableMinor:'20000'}}),'MERCHANT_BALANCE_INVALID');
      await fail(()=>registerTestIntent(pool,{...registration,
        paymentIntentId:'pi_another_0123456789'}),'INTENT_CONFLICT');
      const signed=event(paymentIntentId,eventId);
      await fail(()=>recordSignedTestCapture(pool,
        {...signed,signatureHeader:signed.signatureHeader.replace(/.$/,'0')}),
        'WEBHOOK_SIGNATURE_INVALID');
      await fail(()=>recordSignedTestCapture(pool,
        event(paymentIntentId,'evt_low_amount_123456',30649)),
        'PAYMENT_AMOUNT_MISMATCH');
      const noContract=event('pi_unknown_12345678','evt_unknown_12345678');
      await fail(()=>recordSignedTestCapture(pool,noContract),'PAYMENT_INTENT_UNKNOWN');
      const before=await pool.query(
        'SELECT count(*)::int AS n FROM tala_finance_v2.journals WHERE order_id=$1',
        [orderId]);
      assert.equal(before.rows[0].n,0);

      // Eight duplicate webhook workers may race; exactly one writes a journal.
      const attempts=await Promise.all(Array.from({length:8},()=>
        recordSignedTestCapture(pool,signed)));
      assert.equal(attempts.filter(x=>!x.replayed).length,1);
      assert.equal(attempts.filter(x=>x.replayed).length,7);
      assert.equal(new Set(attempts.map(x=>x.journalId)).size,1);
      const journal=await pool.query(
        'SELECT * FROM tala_finance_v2.journals WHERE order_id=$1',[orderId]);
      assert.equal(journal.rows.length,1);
      assert.equal(journal.rows[0].source_event_id,eventId);
      assert.equal(journal.rows[0].currency,'MXN');
      const receipt=await pool.query(
        'SELECT * FROM tala_finance_v2.stripe_test_receipts WHERE event_id=$1',[eventId]);
      assert.equal(receipt.rows.length,1);
      assert.equal(receipt.rows[0].journal_id,journal.rows[0].id);
      const movements=await pool.query(
        'SELECT side,sum(amount_minor)::text AS total FROM tala_finance_v2.postings WHERE order_id=$1 GROUP BY side',
        [orderId]);
      const totals=Object.fromEntries(movements.rows.map(x=>[x.side,x.total]));
      assert.deepEqual(totals,{credit:'30650',debit:'30650'});

      // A second event for an already captured order MUST NOT credit twice.
      await fail(()=>recordSignedTestCapture(pool,
        event(paymentIntentId,'evt_second_123456789')),
        'ORDER_ALREADY_CAPTURED');
      // A valid signature for different raw bytes with the same eventId
      // must not be accepted as a harmless replay.
      const altered=Buffer.from(JSON.stringify({
        id:eventId,livemode:false,type:'payment_intent.succeeded',
        data:{object:{id:paymentIntentId,object:'payment_intent',currency:'mxn',
          status:'succeeded',amount:30650,amount_received:30650,
          metadata:{arbitrary:'difference'}}}
      }));
      await fail(()=>recordSignedTestCapture(pool,{
        rawBody:altered,signatureHeader:sign(altered),webhookSecret:secret
      }),'WEBHOOK_REPLAY_CONFLICT');

      const order2=randomUUID();
      await fail(()=>registerTestIntent(pool,{...registration,orderId:order2}),
        'INTENT_CONFLICT');
      const intents=await pool.query(
        'SELECT count(*)::int AS n FROM tala_finance_v2.test_intents WHERE order_id=$1',
        [orderId]);
      assert.equal(intents.rows[0].n,1);
    }finally{await pool.end();}
  });
