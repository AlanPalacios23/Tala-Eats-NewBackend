import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {FinanceError} from '../src/ledger.mjs';
import {
  recordLabHeldAllocation,assignLabDriverHeldClaim,readDriverHeldBalance,
  reverseLabHeldAllocation,readMerchantFinancialBalance
} from '../src/store.mjs';

const url=process.env.FINANCE_CI_URL??'';
const enabled=/\/tala_finance_v2_test(?:$|\?)/.test(url);
const key=()=> 'finance-driver-lab-'+randomUUID();
const snap={
  currency:'MXN',policyVersion:'lab-driver-only-v1',fulfillment:'delivery',
  itemsMinor:'25000',merchantCommissionMinor:'3750',
  merchantPayableMinor:'21250',serviceFeeMinor:'1750',
  deliveryFeeMinor:'3900',driverPayableMinor:'3200',
  tipMinor:'0',totalMinor:'30650',platformGrossMinor:'6200'
};
const pickup={...snap,fulfillment:'pickup',
  deliveryFeeMinor:'0',driverPayableMinor:'0',
  totalMinor:'26750',platformGrossMinor:'5500'};
const expectFinance=async(work,code)=>assert.rejects(work,
  e=>e instanceof FinanceError&&e.code===code);

test('M3 attributes a HELD driver allocation exactly once without extra money',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=new Pool({connectionString:url,max:16,connectionTimeoutMillis:3000});
  try{
    const orderId=randomUUID(),restaurantId=randomUUID(),driverId=randomUUID(),
      commandKey=key();
    await recordLabHeldAllocation(pool,{
      orderId,restaurantId,snapshot:snap,commandKey:key()
    });
    const before=(await pool.query(
      'SELECT count(*)::int AS n FROM tala_finance_v2.journals WHERE order_id=$1',
      [orderId])).rows[0].n;
    const replies=await Promise.all(Array.from({length:12},()=>assignLabDriverHeldClaim(
      pool,{orderId,driverId,commandKey}
    )));
    assert.equal(replies.filter(x=>x.replayed===false).length,1);
    assert.equal(replies.filter(x=>x.replayed===true).length,11);
    assert.equal(new Set(replies.map(x=>x.claimId)).size,1);
    assert.ok(replies.every(x=>x.heldMinor==='3200'&&x.availableMinor==='0'));
    const balance=await readDriverHeldBalance(pool,driverId);
    assert.deepEqual(balance,{
      driverId,currency:'MXN',pendingHeldMinor:'3200',
      availableMinor:'0',withdrawable:false,source:'internal_accounting_only'
    });
    const merchant=await readMerchantFinancialBalance(pool,restaurantId);
    assert.equal(merchant.pendingMinor,'21250');
    assert.equal(merchant.availableMinor,'0');
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM tala_finance_v2.journals WHERE order_id=$1',
      [orderId])).rows[0].n,before);
    await expectFinance(()=>assignLabDriverHeldClaim(pool,{
      orderId,driverId:randomUUID(),commandKey:key()
    }),'FINANCE_DRIVER_CLAIM_CONFLICT');
    await expectFinance(()=>assignLabDriverHeldClaim(pool,{
      orderId,driverId,commandKey:key()
    }),'FINANCE_DRIVER_CLAIM_CONFLICT');
    await reverseLabHeldAllocation(pool,{orderId,commandKey:key()});
    assert.equal((await readDriverHeldBalance(pool,driverId)).pendingHeldMinor,'0');
    assert.equal((await readDriverHeldBalance(pool,driverId)).availableMinor,'0');
    await expectFinance(()=>assignLabDriverHeldClaim(pool,{
      orderId,driverId,commandKey
    }),'FINANCE_ALREADY_REVERSED');
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM tala_finance_v2.driver_held_claims WHERE order_id=$1',
      [orderId])).rows[0].n,1);
    const claimId=replies[0].claimId;
    await assert.rejects(pool.query(
      'DELETE FROM tala_finance_v2.driver_held_claims WHERE id=$1',
      [claimId]),/FINANCE_JOURNAL_IMMUTABLE/);
    await assert.rejects(pool.query(
      'UPDATE tala_finance_v2.driver_held_claims SET amount_minor=1 WHERE id=$1',
      [claimId]),/FINANCE_JOURNAL_IMMUTABLE/);
  }finally{await pool.end();}
});

test('M3 driver claim fails closed for pickup, reversal and forged SQL',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=new Pool({connectionString:url,max:6});
  try{
    const merchant=randomUUID(),driver=randomUUID();
    const pickupOrder=randomUUID();
    await recordLabHeldAllocation(pool,{
      orderId:pickupOrder,restaurantId:merchant,snapshot:pickup,commandKey:key()
    });
    await expectFinance(()=>assignLabDriverHeldClaim(pool,{
      orderId:pickupOrder,driverId:driver,commandKey:key()
    }),'FINANCE_NO_DRIVER_HELD');
    const originalOrder=randomUUID();
    const r=await recordLabHeldAllocation(pool,{
      orderId:originalOrder,restaurantId:merchant,snapshot:snap,commandKey:key()
    });
    const sql=`INSERT INTO tala_finance_v2.driver_held_claims
      (original_journal_id,order_id,restaurant_id,driver_id,amount_minor,event_key)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6)`;
    const args=[r.journalId,originalOrder,merchant,driver];
    const hash='a'.repeat(64);
    await assert.rejects(pool.query(sql,[...args,'100',hash]),
      e=>e.code==='23514');
    await assert.rejects(pool.query(sql,[r.journalId,pickupOrder,
      merchant,driver,'3200',hash]),e=>e.code==='23514'||e.code==='23503');
    await assert.rejects(pool.query(sql,[r.journalId,originalOrder,
      randomUUID(),driver,'3200',hash]),e=>e.code==='23514'||e.code==='23503');
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM tala_finance_v2.driver_held_claims WHERE order_id=$1',
      [originalOrder])).rows[0].n,0);
    await reverseLabHeldAllocation(pool,{orderId:originalOrder,commandKey:key()});
    await assert.rejects(pool.query(sql,[...args,'3200',hash]),
      e=>e.code==='23514');
    const unknown=await readDriverHeldBalance(pool,randomUUID());
    assert.equal(unknown.pendingHeldMinor,'0');
    assert.equal(unknown.availableMinor,'0');
  }finally{await pool.end();}
});


test('M3 distinct couriers competing for ONE held share cannot double-attribute',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=new Pool({connectionString:url,max:12,connectionTimeoutMillis:3000});
  try{
    const orderId=randomUUID(),restaurantId=randomUUID(),
      drivers=[randomUUID(),randomUUID()];
    await recordLabHeldAllocation(pool,{
      orderId,restaurantId,snapshot:snap,commandKey:key()
    });
    const results=await Promise.allSettled(drivers.map(driverId=>
      assignLabDriverHeldClaim(pool,{orderId,driverId,commandKey:key()})));
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.find(x=>x.status==='rejected')?.reason?.code,
      'FINANCE_DRIVER_CLAIM_CONFLICT');
    const balances=await Promise.all(drivers.map(driverId=>
      readDriverHeldBalance(pool,driverId)));
    assert.equal(balances.reduce((s,x)=>s+BigInt(x.pendingHeldMinor),0n),3200n);
    assert.ok(balances.every(x=>x.availableMinor==='0'&&!x.withdrawable));
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM tala_finance_v2.driver_held_claims WHERE order_id=$1',
      [orderId])).rows[0].n,1);
  }finally{await pool.end();}
});

test('M3 reversal racing driver attribution never leaves outstanding driver funds',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=new Pool({connectionString:url,max:12,connectionTimeoutMillis:3000});
  try{
    const orderId=randomUUID(),restaurantId=randomUUID(),driverId=randomUUID();
    await recordLabHeldAllocation(pool,{
      orderId,restaurantId,snapshot:snap,commandKey:key()
    });
    const [claim,reversal]=await Promise.allSettled([
      assignLabDriverHeldClaim(pool,{orderId,driverId,commandKey:key()}),
      reverseLabHeldAllocation(pool,{orderId,commandKey:key()})
    ]);
    assert.equal(reversal.status,'fulfilled');
    if(claim.status==='rejected')
      assert.equal(claim.reason?.code,'FINANCE_ALREADY_REVERSED');
    assert.equal((await readDriverHeldBalance(pool,driverId)).pendingHeldMinor,'0');
    assert.equal((await readDriverHeldBalance(pool,driverId)).availableMinor,'0');
    assert.equal((await readMerchantFinancialBalance(pool,restaurantId)).pendingMinor,'0');
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM tala_finance_v2.held_reversals WHERE order_id=$1',
      [orderId])).rows[0].n,1);
  }finally{await pool.end();}
});
