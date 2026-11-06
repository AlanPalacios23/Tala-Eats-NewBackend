import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {FinanceError} from '../src/ledger.mjs';
import {recordLabHeldAllocation,reverseLabHeldAllocation,
  readMerchantFinancialBalance} from '../src/store.mjs';
import {auditInternalLedger} from '../src/reconciliation.mjs';

const url=process.env.FINANCE_CI_URL??'';
const enabled=/\/tala_finance_v2_test(?:$|\?)/.test(url);
const snapshot={
  currency:'MXN',policyVersion:'lab-finance-only-reversal-v1',
  fulfillment:'delivery',itemsMinor:'25000',merchantCommissionMinor:'3750',
  merchantPayableMinor:'21250',serviceFeeMinor:'1750',
  deliveryFeeMinor:'3900',driverPayableMinor:'3200',tipMinor:'0',
  totalMinor:'30650',platformGrossMinor:'6200'
};
const key=()=> 'finance-rollback-'+randomUUID();
const rejects=async(fn,code)=>assert.rejects(fn,e=>
  e instanceof FinanceError&&e.code===code);
const connection=()=>new Pool({
  connectionString:url,max:16,connectionTimeoutMillis:3000
});
async function pending(pool,restaurantId){
  return (await readMerchantFinancialBalance(pool,restaurantId)).pendingMinor;
}

test('M3 reverses full held allocations exactly once, preserving double entry',
  {skip:!enabled,timeout:70000},async()=>{
  const pool=connection();
  try{
    const restaurantId=randomUUID(),orderId=randomUUID();
    const original=await recordLabHeldAllocation(pool,{
      restaurantId,orderId,snapshot,commandKey:key()
    });
    assert.equal(await pending(pool,restaurantId),'21250');
    const commandKey=key();
    const reversals=await Promise.all(Array.from({length:12},()=>
      reverseLabHeldAllocation(pool,{orderId,commandKey})));
    assert.equal(reversals.filter(r=>!r.replayed).length,1);
    assert.equal(reversals.filter(r=>r.replayed).length,11);
    assert.equal(new Set(reversals.map(r=>r.reversalId)).size,1);
    assert.equal(reversals[0].originalJournalId,original.journalId);
    assert.equal(await pending(pool,restaurantId),'0');
    const b=await readMerchantFinancialBalance(pool,restaurantId);
    assert.equal(b.availableMinor,'0');
    assert.equal(b.withdrawable,false);
    await rejects(()=>reverseLabHeldAllocation(pool,{orderId,commandKey:key()}),
      'FINANCE_ALREADY_REVERSED');
    await rejects(()=>reverseLabHeldAllocation(pool,{orderId:randomUUID(),
      commandKey:key()}),'FINANCE_ALLOCATION_NOT_FOUND');
    const rows=await pool.query(`
      SELECT account_code,side,amount_minor::text FROM
        tala_finance_v2.postings WHERE order_id=$1
      UNION ALL
      SELECT account_code,side,amount_minor::text FROM
        tala_finance_v2.reversal_postings WHERE order_id=$1`,[orderId]);
    assert.equal(rows.rows.length,8);
    const totals=new Map();
    for(const x of rows.rows){
      const delta=x.side==='debit'?BigInt(x.amount_minor):-BigInt(x.amount_minor);
      totals.set(x.account_code,(totals.get(x.account_code)??0n)+delta);
    }
    assert.ok([...totals.values()].every(x=>x===0n));
    const audit=await auditInternalLedger(pool,{orderIds:[orderId],limit:5});
    assert.equal(audit.examined,1);
    assert.equal(audit.consistent,1);
    assert.equal(audit.reversed,1);
    assert.equal(audit.entries[0].state,'fully_reversed');
    assert.deepEqual(audit.entries[0].anomalies,[]);
    const aggregate=await pool.query(`
      SELECT account_code,held_minor::text FROM tala_finance_v2.held_liabilities
      WHERE account_code IN ('liability.merchant_pending',
                             'liability.delivery_held','liability.platform_pending')`);
    assert.ok(aggregate.rows.every(x=>BigInt(x.held_minor)>=0n));
    await assert.rejects(pool.query(
      'DELETE FROM tala_finance_v2.held_reversals WHERE id=$1',[reversals[0].reversalId]),
      /FINANCE_JOURNAL_IMMUTABLE/);
    await assert.rejects(pool.query(
      'UPDATE tala_finance_v2.held_reversals SET snapshot_hash=$2 WHERE id=$1',
      [reversals[0].reversalId,'a'.repeat(64)]),/FINANCE_JOURNAL_IMMUTABLE/);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS n FROM tala_finance_v2.held_reversals
      WHERE original_journal_id=$1`,[original.journalId])).rows[0].n,1);
  }finally{await pool.end();}
});

test('M3 rejects direct SQL forged partial/cross-merchant compensation',
  {skip:!enabled,timeout:70000},async()=>{
  const pool=connection();
  try{
    const restaurantId=randomUUID(),orderId=randomUUID();
    const held=await recordLabHeldAllocation(pool,{
      orderId,restaurantId,snapshot,commandKey:key()
    });
    const r=await pool.query(`
      SELECT snapshot_hash,lines FROM tala_finance_v2.journals WHERE id=$1`,
      [held.journalId]);
    const correct=r.rows[0].lines.map(x=>({...x,
      side:x.side==='debit'?'credit':'debit'}));
    const args=(lines,owner=restaurantId)=>[
      held.journalId,orderId,owner,'b'.repeat(64),
      r.rows[0].snapshot_hash,JSON.stringify(lines)
    ];
    const sql=`
      INSERT INTO tala_finance_v2.held_reversals
      (original_journal_id,order_id,restaurant_id,event_key,snapshot_hash,lines)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb)`;
    const partial=structuredClone(correct);
    partial[0].amountMinor='1';
    await assert.rejects(pool.query(sql,args(partial)),e=>e.code==='23514');
    await assert.rejects(pool.query(sql,args(correct,randomUUID())),
      e=>e.code==='23514'||e.code==='23503');
    const extra=structuredClone(correct);
    extra[0].canWithdraw=true;
    await assert.rejects(pool.query(sql,args(extra)),e=>e.code==='23514');
    const badSide=structuredClone(correct);
    badSide[1].side='credit';
    await assert.rejects(pool.query(sql,args(badSide)),e=>e.code==='23514');
    assert.equal((await pool.query(`
      SELECT count(*)::int AS n FROM tala_finance_v2.held_reversals
      WHERE original_journal_id=$1`,[held.journalId])).rows[0].n,0);
  }finally{await pool.end();}
});

test('M3 serializes distinct commands racing on the same pending allocation',
  {skip:!enabled,timeout:70000},async()=>{
  const pool=connection();
  try{
    const restaurantId=randomUUID(),orderId=randomUUID();
    await recordLabHeldAllocation(pool,{orderId,restaurantId,snapshot,
      commandKey:key()});
    const results=await Promise.allSettled([
      reverseLabHeldAllocation(pool,{orderId,commandKey:key()}),
      reverseLabHeldAllocation(pool,{orderId,commandKey:key()})
    ]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.find(r=>r.status==='rejected')?.reason?.code,
      'FINANCE_ALREADY_REVERSED');
    assert.equal(await pending(pool,restaurantId),'0');
  }finally{await pool.end();}
});
