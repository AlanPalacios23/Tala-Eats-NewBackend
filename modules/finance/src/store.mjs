/**
 * M3 LAB1: PostgreSQL-backed Stripe TEST only. No public HTTP, LIVE keys,
 * external payment calls, payouts, wallets or dependency on M1/M2 tables.
 *
 * The trusted registration API is an internal fixture, never client-facing.
 */
import {FinanceError,validateFinancialSnapshot,proposeCaptureJournal} from './ledger.mjs';
import {sha256,verifySignedTestEvent} from './stripe-test-webhook.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PI=/^pi_[A-Za-z0-9_]{6,150}$/;
const AMOUNTS=[
  'itemsMinor','merchantCommissionMinor','merchantPayableMinor',
  'serviceFeeMinor','deliveryFeeMinor','driverPayableMinor',
  'tipMinor','totalMinor','platformGrossMinor'
];
const normId=(id)=>{
  if(typeof id!=='string'||!UUID.test(id))throw new FinanceError('ACTOR_ID_INVALID');
  return id.toLowerCase();
};
const normalize=(input={})=>{
  if(!input||typeof input!=='object')throw new FinanceError('INTENT_INVALID');
  const orderId=normId(input.orderId);
  const restaurantId=normId(input.restaurantId);
  const driverId=input.driverId===null||input.driverId===undefined
    ?null:normId(input.driverId);
  const pi=input.paymentIntentId;
  if(typeof pi!=='string'||!PI.test(pi))throw new FinanceError('PAYMENT_INTENT_INVALID');
  const m=validateFinancialSnapshot(input.snapshot);
  if((m.driverPayableMinor>0n&&!driverId)||m.totalMinor<=0n)
    throw new FinanceError('INTENT_CONTRACT_INVALID');
  const snapshot={currency:m.currency,policyVersion:m.policyVersion,fulfillment:m.fulfillment,
    ...Object.fromEntries(AMOUNTS.map(k=>[k,m[k].toString()]))};
  const canonical=JSON.stringify([orderId,restaurantId,driverId,pi,
    snapshot.currency,snapshot.policyVersion,snapshot.fulfillment,
    ...AMOUNTS.map(k=>snapshot[k])]);
  return {orderId,restaurantId,driverId,paymentIntentId:pi,snapshot,
    contractHash:sha256(Buffer.from(canonical)),expectedMinor:snapshot.totalMinor};
};
const begin=async c=>{
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout='3000ms'");
  await c.query("SET LOCAL statement_timeout='10000ms'");
  const check=await c.query('SELECT current_database() AS db');
  if(!['tala_finance_v2_lab','tala_finance_v2_test'].includes(check.rows[0]?.db))
    throw new FinanceError('FINANCE_LAB_ONLY');
};
const transaction=async(pool,fn)=>{
  const c=await pool.connect();
  try{
    await begin(c);
    const result=await fn(c);
    await c.query('COMMIT');
    return result;
  }catch(error){
    await c.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{c.release();}
};

/**
 * Trusted internal registration, not a Stripe API call or a paid confirmation.
 * Immutable contracts. Exactly repeated registration is idempotent.
 */
export async function registerTestIntent(pool,input){
  const v=normalize(input);
  return transaction(pool,async c=>{
    const inserted=await c.query(`
      INSERT INTO tala_finance_v2.test_intents
      (order_id,restaurant_id,driver_id,payment_intent_id,
       snapshot,contract_hash,expected_minor)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7::bigint)
      ON CONFLICT DO NOTHING RETURNING order_id`,
      [v.orderId,v.restaurantId,v.driverId,v.paymentIntentId,
        JSON.stringify(v.snapshot),v.contractHash,v.expectedMinor]);
    if(inserted.rowCount)return {orderId:v.orderId,replayed:false};
    const previous=await c.query(`
      SELECT order_id,restaurant_id,driver_id,payment_intent_id,contract_hash,
        expected_minor FROM tala_finance_v2.test_intents
      WHERE order_id=$1::uuid OR payment_intent_id=$2
      FOR UPDATE`,[v.orderId,v.paymentIntentId]);
    const p=previous.rows[0];
    if(previous.rowCount!==1||!p||p.order_id!==v.orderId||
       p.restaurant_id!==v.restaurantId||p.driver_id!==v.driverId||
       p.payment_intent_id!==v.paymentIntentId||
       p.contract_hash!==v.contractHash||
       p.expected_minor!==v.expectedMinor)
      throw new FinanceError('INTENT_CONFLICT');
    return {orderId:v.orderId,replayed:true};
  });
}

/**
 * Raw TEST HMAC plus a matching trusted contract are mandatory. Journal and
 * receipt commit atomically; serialization on intent prevents double posting.
 */
export async function recordSignedTestCapture(pool,{rawBody,signatureHeader,webhookSecret}={}){
  const event=verifySignedTestEvent(rawBody,signatureHeader,webhookSecret);
  return transaction(pool,async c=>{
    const found=await c.query(`
      SELECT order_id,restaurant_id,driver_id,payment_intent_id,snapshot,
        contract_hash,expected_minor
      FROM tala_finance_v2.test_intents
      WHERE payment_intent_id=$1 FOR UPDATE`,[event.paymentIntentId]);
    if(!found.rowCount)throw new FinanceError('PAYMENT_INTENT_UNKNOWN');
    const intent=found.rows[0];
    const verified=normalize({
      orderId:intent.order_id,restaurantId:intent.restaurant_id,
      driverId:intent.driver_id,paymentIntentId:intent.payment_intent_id,
      snapshot:intent.snapshot
    });
    if(verified.contractHash!==intent.contract_hash||
       verified.expectedMinor!==intent.expected_minor)
      throw new FinanceError('INTENT_TAMPERED');
    if(event.amountMinor!==verified.expectedMinor)
      throw new FinanceError('PAYMENT_AMOUNT_MISMATCH');
    const existing=await c.query(`
      SELECT r.event_id,r.order_id,r.raw_hash,j.id AS journal_id,
        j.snapshot_hash,j.source_event_id
      FROM tala_finance_v2.stripe_test_receipts r
      JOIN tala_finance_v2.journals j ON j.id=r.journal_id
      WHERE r.event_id=$1`,[event.eventId]);
    const proposal=proposeCaptureJournal({
      orderId:verified.orderId,restaurantId:verified.restaurantId,
      driverId:verified.driverId,snapshot:verified.snapshot,
      evidence:{sourceSystem:'stripe_test',kind:'capture_verified',eventId:event.eventId}
    });
    if(existing.rowCount){
      const old=existing.rows[0];
      if(old.order_id!==verified.orderId||old.raw_hash!==event.rawHash||
         old.snapshot_hash!==proposal.snapshotHash||
         old.source_event_id!==event.eventId)
        throw new FinanceError('WEBHOOK_REPLAY_CONFLICT');
      return {orderId:verified.orderId,journalId:old.journal_id,replayed:true};
    }
    const captured=await c.query(`
      SELECT id FROM tala_finance_v2.journals
      WHERE order_id=$1::uuid AND kind='capture'`,[verified.orderId]);
    if(captured.rowCount)throw new FinanceError('ORDER_ALREADY_CAPTURED');
    const entry=await c.query(`
      INSERT INTO tala_finance_v2.journals
      (order_id,kind,source_system,source_event_id,snapshot_hash,currency,lines)
      VALUES($1::uuid,'capture','stripe_test',$2,$3,'MXN',$4::jsonb)
      RETURNING id`,
      [verified.orderId,event.eventId,proposal.snapshotHash,JSON.stringify(proposal.lines)]);
    const journalId=entry.rows[0].id;
    await c.query(`
      INSERT INTO tala_finance_v2.stripe_test_receipts
      (event_id,payment_intent_id,order_id,journal_id,raw_hash)
      VALUES($1,$2,$3::uuid,$4::uuid,$5)`,
      [event.eventId,event.paymentIntentId,verified.orderId,journalId,event.rawHash]);
    return {orderId:verified.orderId,journalId,replayed:false};
  });
}
