import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {FinanceError,proposeHeldAllocation} from '../src/ledger.mjs';
import {recordLabHeldAllocation,readMerchantFinancialBalance} from '../src/store.mjs';
import {auditInternalLedger} from '../src/reconciliation.mjs';

const url=process.env.FINANCE_CI_URL??'';
const enabled=/\/tala_finance_v2_test(?:$|\?)/.test(url);
const snap={
  currency:'MXN',policyVersion:'lab-finance-only-v1',fulfillment:'delivery',
  itemsMinor:'25000',merchantCommissionMinor:'3750',merchantPayableMinor:'21250',
  serviceFeeMinor:'1750',deliveryFeeMinor:'3900',driverPayableMinor:'3200',
  tipMinor:'0',totalMinor:'30650',platformGrossMinor:'6200'
};
const fails=async(fn,code)=>assert.rejects(fn,e=>e instanceof FinanceError&&e.code===code);
const key=()=> 'finance-command-'+randomUUID();

test('M3 financial-only PostgreSQL: journal, wallet, replay and audit',
  {skip:!enabled,timeout:70000},async()=>{
  const pool=new Pool({connectionString:url,max:12,connectionTimeoutMillis:3000});
  try{
    const restaurantId=randomUUID(),orderId=randomUUID(),commandKey=key();
    const request={orderId,restaurantId,commandKey,snapshot:snap};
    const results=await Promise.all(Array.from({length:8},()=>
      recordLabHeldAllocation(pool,request)));
    assert.equal(results.filter(r=>r.replayed===false).length,1);
    assert.equal(results.filter(r=>r.replayed===true).length,7);
    assert.equal(new Set(results.map(x=>x.journalId)).size,1);
    const journalId=results[0].journalId;
    const row=await pool.query(
      'SELECT * FROM tala_finance_v2.journals WHERE order_id=$1',[orderId]);
    assert.equal(row.rows.length,1);
    assert.equal(row.rows[0].kind,'allocation_held');
    assert.equal(row.rows[0].currency,'MXN');
    assert.equal(row.rows[0].snapshot.totalMinor,'30650');
    await fails(()=>recordLabHeldAllocation(pool,{...request,commandKey:key()}),
      'FINANCE_ORDER_ALREADY_ALLOCATED');
    await fails(()=>recordLabHeldAllocation(pool,{...request,
      snapshot:{...snap,policyVersion:'changed-pilot'}}),
      'FINANCE_IDEMPOTENCY_CONFLICT');

    const wallet=await readMerchantFinancialBalance(pool,restaurantId);
    assert.deepEqual(wallet,{
      restaurantId,currency:'MXN',pendingMinor:'21250',availableMinor:'0',
      withdrawable:false,source:'internal_accounting_only'
    });
    const missing=await readMerchantFinancialBalance(pool,randomUUID());
    assert.equal(missing.pendingMinor,'0');
    assert.equal(missing.availableMinor,'0');
    const postings=await pool.query(`
      SELECT account_code,party_id,side,amount_minor::text
      FROM tala_finance_v2.postings WHERE journal_id=$1::uuid`,[journalId]);
    assert.equal(postings.rows.length,4);
    assert.equal(postings.rows.find(x=>x.account_code==='liability.delivery_held')
      .party_id,null);
    assert.equal(postings.rows.find(x=>x.account_code==='liability.platform_pending')
      .amount_minor,'6200');
    const totals=postings.rows.reduce((acc,x)=>{
      acc[x.side]=(acc[x.side]??0n)+BigInt(x.amount_minor);
      return acc;
    },{});
    assert.equal(totals.debit,30650n);
    assert.equal(totals.credit,30650n);

    // Direct SQL with invalid money amounts or mismatched allocations
    // must fail at the database boundary, not just inside JS.
    const another=randomUUID(),bad=proposeHeldAllocation({
      orderId:another,restaurantId,snapshot:snap,commandKey:key()
    });
    const broken=bad.lines.map(x=>({...x}));
    broken.find(x=>x.accountCode==='liability.merchant_pending')
      .amountMinor='21249';
    await assert.rejects(pool.query(`
      INSERT INTO tala_finance_v2.journals
      (order_id,restaurant_id,event_key,snapshot_hash,snapshot,lines)
      VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6::jsonb)`,
      [another,restaurantId,bad.eventKey,bad.snapshotHash,
        JSON.stringify(bad.snapshot),JSON.stringify(broken)]),e=>e.code==='23514');
    const withMetadata=bad.lines.map(x=>({...x}));
    withMetadata[0].stripePaymentIntentId='unexpected';
    await assert.rejects(pool.query(`
      INSERT INTO tala_finance_v2.journals
      (order_id,restaurant_id,event_key,snapshot_hash,snapshot,lines)
      VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6::jsonb)`,
      [another,restaurantId,bad.eventKey,bad.snapshotHash,
        JSON.stringify(bad.snapshot),JSON.stringify(withMetadata)]),e=>e.code==='23514');

    // Append-only protection: neither original entries nor identity can change.
    await assert.rejects(pool.query(
      'UPDATE tala_finance_v2.journals SET snapshot_hash=$2 WHERE id=$1::uuid',
      [journalId,'f'.repeat(64)]),/FINANCE_JOURNAL_IMMUTABLE/);
    await assert.rejects(pool.query(
      'DELETE FROM tala_finance_v2.journals WHERE id=$1::uuid',
      [journalId]),/FINANCE_JOURNAL_IMMUTABLE/);

    const wrongHashOrder=randomUUID();
    const badHash=proposeHeldAllocation({orderId:wrongHashOrder,restaurantId,
      snapshot:snap,commandKey:key()});
    await pool.query(`
      INSERT INTO tala_finance_v2.journals
      (order_id,restaurant_id,event_key,snapshot_hash,snapshot,lines)
      VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6::jsonb)`,
      [wrongHashOrder,restaurantId,badHash.eventKey,'a'.repeat(64),
        JSON.stringify(badHash.snapshot),JSON.stringify(badHash.lines)]);
    const audit=await auditInternalLedger(pool,{
      orderIds:[orderId,wrongHashOrder],limit:10
    });
    assert.equal(audit.externallyReconciled,false);
    assert.equal(audit.withdrawalsAuthorized,false);
    assert.equal(audit.scope,'explicit_orders');
    assert.equal(audit.examined,2);
    assert.equal(audit.consistent,1);
    assert.equal(audit.needsReview,1);
    const byId=Object.fromEntries(audit.entries.map(x=>[x.orderId,x]));
    assert.equal(byId[orderId].state,'held_internally_consistent');
    assert.deepEqual(byId[wrongHashOrder].anomalies,['SNAPSHOT_HASH_MISMATCH']);
    assert.ok(audit.entries.every(x=>x.availableMinor==='0'));
    assert.equal(JSON.stringify(audit).includes('customer'),false);
    assert.equal(JSON.stringify(audit).includes('stripe'),false);

    await fails(()=>auditInternalLedger(pool,{limit:0}),
      'FINANCE_AUDIT_LIMIT_INVALID');
    await fails(()=>auditInternalLedger(pool,{orderIds:['bad-id']}),
      'FINANCE_AUDIT_SCOPE_INVALID');
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM tala_finance_v2.journals WHERE order_id=$1',
      [orderId])).rows[0].n,1);
  }finally{await pool.end();}
});
