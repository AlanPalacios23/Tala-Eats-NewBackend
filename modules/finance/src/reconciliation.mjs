/**
 * M3 LAB1.2 — READ-ONLY financial reconciliation on the isolated TEST DB.
 * Distinguishes "awaiting payment" from broken accounting. Does not grant
 * balance availability, release funds or call Stripe/M1/M2.
 */
import {FinanceError,validateFinancialSnapshot} from './ledger.mjs';
import {sha256} from './stripe-test-webhook.mjs';

const DB=new Set(['tala_finance_v2_test','tala_finance_v2_lab']);
const MAX_LIMIT=100;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNTS=[
  'itemsMinor','merchantCommissionMinor','merchantPayableMinor',
  'serviceFeeMinor','deliveryFeeMinor','driverPayableMinor',
  'tipMinor','totalMinor','platformGrossMinor'
];
function validMoney(value) {
  return typeof value==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(value)&&
    BigInt(value)<=1_000_000_000_000n;
}
function canonicalContract(row) {
  const snapshot=row.snapshot;
  if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))
    return null;
  const expectedKeys=['currency','policyVersion','fulfillment',...AMOUNTS];
  if(Object.keys(snapshot).sort().join('|')!==expectedKeys.sort().join('|')||
     !AMOUNTS.every(key=>validMoney(snapshot[key])))
    return null;
  // A matching checksum alone is insufficient: a forged SQL writer could
  // rehash an arithmetically invalid but superficially well-formed snapshot.
  try{validateFinancialSnapshot(snapshot);}
  catch{return null;}
  return sha256(Buffer.from(JSON.stringify([
    row.order_id,row.restaurant_id,row.driver_id??null,row.payment_intent_id,
    snapshot.currency,snapshot.policyVersion,snapshot.fulfillment,
    ...AMOUNTS.map(k=>snapshot[k])
  ])));
}
function reasonsFor(row) {
  const reasons=[];
  if(!row.journal_id&&!row.receipt_id)return reasons;
  if(!row.journal_id)reasons.push('RECEIPT_WITHOUT_JOURNAL');
  if(!row.receipt_id)reasons.push('JOURNAL_WITHOUT_RECEIPT');
  if(row.journal_id&&row.receipt_id&&row.receipt_journal_id!==row.journal_id)
    reasons.push('JOURNAL_RECEIPT_MISMATCH');
  if(row.journal_id&&row.receipt_id&&row.receipt_event_id!==row.source_event_id)
    reasons.push('EVENT_MISMATCH');
  if(row.journal_id&&row.debit_minor!==row.expected_minor)
    reasons.push('CAPTURE_AMOUNT_MISMATCH');
  if(row.journal_id&&row.credit_minor!==row.expected_minor)
    reasons.push('CREDIT_AMOUNT_MISMATCH');
  if(row.journal_id&&row.merchant_minor!==row.snapshot?.merchantPayableMinor)
    reasons.push('MERCHANT_ALLOCATION_MISMATCH');
  if(row.journal_id&&row.driver_minor!==row.snapshot?.driverPayableMinor)
    reasons.push('DRIVER_ALLOCATION_MISMATCH');
  if(row.journal_id&&row.platform_minor!==row.snapshot?.platformGrossMinor)
    reasons.push('PLATFORM_ALLOCATION_MISMATCH');
  return reasons;
}
/**
 * Structured, non-PII diagnostic evidence for ONE account/batch.
 * The method is internal only: never expose to clients or claim Stripe
 * reconciliation without independently querying the provider in TEST mode.
 */
export async function reconcileTestFinances(pool,{limit=50,orderIds}={}){
  if(!Number.isInteger(limit)||limit<1||limit>MAX_LIMIT)
    throw new FinanceError('RECONCILIATION_LIMIT_INVALID');
  if(orderIds!==undefined&&(!Array.isArray(orderIds)||orderIds.length===0||
    orderIds.length>MAX_LIMIT||orderIds.some(id=>typeof id!=='string'||!UUID.test(id))))
    throw new FinanceError('RECONCILIATION_SCOPE_INVALID');
  const ids=orderIds??null;
  const client=await pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='10000ms'");
    const db=await client.query('SELECT current_database() AS name');
    if(!DB.has(db.rows[0]?.name))throw new FinanceError('FINANCE_LAB_ONLY');
    const result=await client.query(`
      SELECT
        i.order_id,i.restaurant_id,i.driver_id,i.payment_intent_id,
        i.snapshot,i.contract_hash,i.expected_minor::text,
        j.id AS journal_id,j.source_event_id,j.snapshot_hash,
        r.event_id AS receipt_id,r.journal_id AS receipt_journal_id,
        r.event_id AS receipt_event_id,
        COALESCE(p.debit_minor,0)::text AS debit_minor,
        COALESCE(p.credit_minor,0)::text AS credit_minor,
        COALESCE(p.merchant_minor,0)::text AS merchant_minor,
        COALESCE(p.driver_minor,0)::text AS driver_minor,
        COALESCE(p.platform_minor,0)::text AS platform_minor
      FROM tala_finance_v2.test_intents i
      LEFT JOIN tala_finance_v2.journals j
        ON j.order_id=i.order_id AND j.kind='capture'
      LEFT JOIN tala_finance_v2.stripe_test_receipts r
        ON r.order_id=i.order_id
      LEFT JOIN LATERAL (
        SELECT
          sum(CASE WHEN p.side='debit' THEN p.amount_minor ELSE 0 END)::numeric AS debit_minor,
          sum(CASE WHEN p.side='credit' THEN p.amount_minor ELSE 0 END)::numeric AS credit_minor,
          sum(CASE WHEN p.account_code='liability.merchant_pending'
                   AND p.party_id=i.restaurant_id::text
                   THEN p.amount_minor ELSE 0 END)::numeric AS merchant_minor,
          sum(CASE WHEN p.account_code='liability.driver_held'
                   THEN p.amount_minor ELSE 0 END)::numeric AS driver_minor,
          sum(CASE WHEN p.account_code='liability.platform_pending'
                   THEN p.amount_minor ELSE 0 END)::numeric AS platform_minor
        FROM tala_finance_v2.postings p
        WHERE p.journal_id=j.id
      ) p ON true
      WHERE ($2::uuid[] IS NULL OR i.order_id=ANY($2::uuid[]))
      ORDER BY i.created_at,i.order_id LIMIT $1`,[limit,ids]);
    const rows=result.rows.map(row=>{
      const reasons=reasonsFor(row);
      const hash=canonicalContract(row);
      if(!hash||hash!==row.contract_hash||
         row.snapshot?.totalMinor!==row.expected_minor)
        reasons.push('INTENT_CONTRACT_INVALID');
      const state=reasons.length?'needs_review':
        row.journal_id?'captured_held':'awaiting_payment';
      return Object.freeze({orderId:row.order_id,state,
        reasons:Object.freeze(reasons),
        expectedMinor:row.expected_minor,
        capturedMinor:row.journal_id?row.debit_minor:'0'});
    });
    // Journals without any registered contract have no source of truth.
    const orphan=await client.query(`
      SELECT j.order_id FROM tala_finance_v2.journals j
      LEFT JOIN tala_finance_v2.test_intents i ON i.order_id=j.order_id
      WHERE i.order_id IS NULL AND
        ($2::uuid[] IS NULL OR j.order_id=ANY($2::uuid[]))
      ORDER BY j.created_at,j.id LIMIT $1`,[limit,ids]);
    await client.query('COMMIT');
    const orphanOrders=orphan.rows.map(x=>x.order_id);
    const stats={
      examined:rows.length,awaitingPayment:rows.filter(x=>x.state==='awaiting_payment').length,
      capturedHeld:rows.filter(x=>x.state==='captured_held').length,
      needsReview:rows.filter(x=>x.state==='needs_review').length+orphanOrders.length
    };
    return Object.freeze({environment:'isolated_stripe_test_lab',
      providerReconciled:false,
      scope:ids?'explicit_orders':'first_batch_only',limit,
      ...stats,orders:Object.freeze(rows),orphanJournalOrderIds:Object.freeze(orphanOrders)});
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{client.release();}
}
