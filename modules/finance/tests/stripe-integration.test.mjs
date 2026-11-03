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
    id,object:'event',livemode:false,type:'payment_intent.succeeded',
    data:{object:{id:pi,object:'payment_intent',livemode:false,currency:'mxn',status:'succeeded',
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
        {...signed,signatureHeader:signed.signatureHeader.slice(0,-1)+
          (signed.signatureHeader.endsWith('0')?'1':'0')}),
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
        id:eventId,object:'event',livemode:false,type:'payment_intent.succeeded',
        data:{object:{id:paymentIntentId,object:'payment_intent',livemode:false,currency:'mxn',
          status:'succeeded',amount:30650,amount_received:30650,
          metadata:{arbitrary:'difference'}}}
      }));
      await fail(()=>recordSignedTestCapture(pool,{
        rawBody:altered,signatureHeader:sign(altered),webhookSecret:secret
      }),'WEBHOOK_REPLAY_CONFLICT');

      const order2=randomUUID();
      await fail(()=>registerTestIntent(pool,{...registration,orderId:order2}),
        'INTENT_CONFLICT');
      // Distinct signed TEST events racing for the same PaymentIntent may not
      // create two journals, even with different provider event IDs.
      const raceOrder=randomUUID(),raceIntent='pi_lab_'+randomUUID().replaceAll('-','');
      await registerTestIntent(pool,{...registration,orderId:raceOrder,
        paymentIntentId:raceIntent});
      const [r1,r2]=await Promise.allSettled([
        recordSignedTestCapture(pool,event(raceIntent,
          'evt_lab_'+randomUUID().replaceAll('-',''))),
        recordSignedTestCapture(pool,event(raceIntent,
          'evt_lab_'+randomUUID().replaceAll('-','')))
      ]);
      assert.equal([r1,r2].filter(x=>x.status==='fulfilled').length,1);
      const rejected=[r1,r2].find(x=>x.status==='rejected');
      assert.equal(rejected?.reason?.code,'ORDER_ALREADY_CAPTURED');
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM tala_finance_v2.journals WHERE order_id=$1',
        [raceOrder])).rows[0].n,1);

      // Two different PaymentIntents racing with the SAME signed event ID
      // must never insert a second capture or leak a raw SQL uniqueness error.
      const collisionA=randomUUID(),collisionB=randomUUID(),
        piA='pi_lab_'+randomUUID().replaceAll('-',''),
        piB='pi_lab_'+randomUUID().replaceAll('-',''),
        collisionEvent='evt_lab_'+randomUUID().replaceAll('-','');
      await registerTestIntent(pool,{...registration,orderId:collisionA,paymentIntentId:piA});
      await registerTestIntent(pool,{...registration,orderId:collisionB,paymentIntentId:piB});
      const collision=await Promise.allSettled([
        recordSignedTestCapture(pool,event(piA,collisionEvent)),
        recordSignedTestCapture(pool,event(piB,collisionEvent))
      ]);
      assert.equal(collision.filter(x=>x.status==='fulfilled').length,1);
      assert.equal(collision.find(x=>x.status==='rejected')?.reason?.code,
        'WEBHOOK_REPLAY_CONFLICT');
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM tala_finance_v2.journals WHERE order_id=ANY($1::uuid[])',
        [[collisionA,collisionB]])).rows[0].n,1);
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM tala_finance_v2.stripe_test_receipts WHERE event_id=$1',
        [collisionEvent])).rows[0].n,1);

      // Provider receipts and internal trusted contracts cannot be rewritten
      // after ingestion; future changes must use append-only compensation.
      await assert.rejects(pool.query(
        'UPDATE tala_finance_v2.stripe_test_receipts SET raw_hash=$2 WHERE event_id=$1',
        [eventId,'a'.repeat(64)]),/FINANCE_JOURNAL_IMMUTABLE/);
      await assert.rejects(pool.query(
        'DELETE FROM tala_finance_v2.stripe_test_receipts WHERE event_id=$1',
        [eventId]),/FINANCE_JOURNAL_IMMUTABLE/);
      await assert.rejects(pool.query(
        'UPDATE tala_finance_v2.test_intents SET expected_minor=1 WHERE order_id=$1',
        [orderId]),/FINANCE_JOURNAL_IMMUTABLE/);
      await assert.rejects(pool.query(
        'DELETE FROM tala_finance_v2.test_intents WHERE order_id=$1',
        [orderId]),/FINANCE_JOURNAL_IMMUTABLE/);

      // Customers may pay before the courier is chosen by M2. Preserve
      // the courier allocation in an unallocated liability, never a wallet.
      const unassignedOrder=randomUUID();
      const unassignedPI='pi_lab_'+randomUUID().replaceAll('-','');
      const unassignedEvent='evt_lab_'+randomUUID().replaceAll('-','');
      await registerTestIntent(pool,{...registration,orderId:unassignedOrder,
        driverId:null,paymentIntentId:unassignedPI});
      const unassigned=await recordSignedTestCapture(pool,
        event(unassignedPI,unassignedEvent));
      assert.equal(unassigned.replayed,false);
      const unallocated=await pool.query(
        'SELECT account_code,party_id,amount_minor::text FROM tala_finance_v2.postings WHERE order_id=$1',
        [unassignedOrder]);
      assert.ok(unallocated.rows.some(x=>x.account_code==='liability.driver_held'&&
        x.party_id===null&&x.amount_minor==='3200'));
      assert.ok(unallocated.rows.some(x=>x.account_code==='liability.merchant_pending'));
      assert.ok(unallocated.rows.some(x=>x.account_code==='liability.platform_pending'));
      assert.equal(unallocated.rows.some(x=>x.account_code.includes('payable')||
        x.account_code.startsWith('income.')),false);

      // Direct SQL must not link a receipt to a real but WRONG order's
      // journal or intent. Composite foreign keys enforce this at DB level.
      const danglingOrder=randomUUID(),danglingEvent='evt_anchor_123456789';
      const orphan=await pool.query(`
        INSERT INTO tala_finance_v2.journals
          (order_id,kind,source_system,source_event_id,snapshot_hash,lines)
        VALUES($1::uuid,'capture','stripe_test',$2,$3,$4::jsonb)
        RETURNING id`,[danglingOrder,danglingEvent,'a'.repeat(64),
        JSON.stringify([
          {accountCode:'asset.stripe_test_clearing',side:'debit',amountMinor:'100'},
          {accountCode:'liability.merchant_pending',partyId:restaurantId,
            side:'credit',amountMinor:'80'},
          {accountCode:'liability.platform_pending',side:'credit',amountMinor:'20'}
        ])]);
      const orphanId=orphan.rows[0].id;
      await assert.rejects(pool.query(`
        INSERT INTO tala_finance_v2.stripe_test_receipts
          (event_id,payment_intent_id,order_id,journal_id,raw_hash)
        VALUES($1,$2,$3::uuid,$4::uuid,$5)`,
        [danglingEvent,paymentIntentId,orderId,orphanId,'a'.repeat(64)]),
        e=>e.code==='23503');
      await assert.rejects(pool.query(`
        INSERT INTO tala_finance_v2.stripe_test_receipts
          (event_id,payment_intent_id,order_id,journal_id,raw_hash)
        VALUES($1,$2,$3::uuid,$4::uuid,$5)`,
        [danglingEvent,paymentIntentId,danglingOrder,orphanId,'a'.repeat(64)]),
        e=>e.code==='23503');
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM tala_finance_v2.stripe_test_receipts WHERE event_id=$1',
        [danglingEvent])).rows[0].n,0);
      const intents=await pool.query(
        'SELECT count(*)::int AS n FROM tala_finance_v2.test_intents WHERE order_id=$1',
        [orderId]);
      assert.equal(intents.rows[0].n,1);
    }finally{await pool.end();}
  });
