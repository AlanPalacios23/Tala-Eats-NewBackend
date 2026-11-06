import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {FinanceError} from '../src/ledger.mjs';
import {recordLabHeldAllocation,reverseLabHeldAllocation,
  readMerchantLedgerStatement,readMerchantFinancialBalance} from '../src/store.mjs';

const url=process.env.FINANCE_CI_URL??'';
const enabled=/\/tala_finance_v2_test(?:$|\?)/.test(url);
const snap={
  currency:'MXN',policyVersion:'lab-statement-v1',
  fulfillment:'delivery',itemsMinor:'25000',
  merchantCommissionMinor:'3750',merchantPayableMinor:'21250',
  serviceFeeMinor:'1750',deliveryFeeMinor:'3900',
  driverPayableMinor:'3200',tipMinor:'0',
  totalMinor:'30650',platformGrossMinor:'6200'
};
const key=()=> 'finance-statement-'+randomUUID();

test('M3 internal statement paginates held and reversal entries without cross-merchant leaks',
  {skip:!enabled,timeout:70000},async()=>{
    const pool=new Pool({connectionString:url,max:10});
    try{
      const restaurantId=randomUUID(),otherRestaurant=randomUUID();
      const orders=[randomUUID(),randomUUID(),randomUUID()];
      for(const orderId of orders){
        await recordLabHeldAllocation(pool,{
          orderId,restaurantId,snapshot:snap,commandKey:key()
        });
      }
      await reverseLabHeldAllocation(pool,{orderId:orders[1],commandKey:key()});
      await recordLabHeldAllocation(pool,{
        orderId:randomUUID(),restaurantId:otherRestaurant,
        snapshot:snap,commandKey:key()
      });
      const first=await readMerchantLedgerStatement(pool,restaurantId,{limit:2});
      assert.equal(first.entries.length,2);
      assert.equal(first.hasMore,true);
      assert.ok(typeof first.nextCursor==='string');
      const second=await readMerchantLedgerStatement(pool,restaurantId,{
        limit:2,cursor:first.nextCursor
      });
      assert.equal(second.entries.length,2);
      assert.equal(second.hasMore,false);
      assert.equal(second.nextCursor,null);
      const all=[...first.entries,...second.entries];
      assert.equal(new Set(all.map(x=>x.entryId)).size,4);
      assert.deepEqual(new Set(all.map(x=>x.orderId)),new Set(orders));
      assert.equal(all.filter(x=>x.kind==='allocation_held').length,3);
      assert.equal(all.filter(x=>x.kind==='full_held_reversal').length,1);
      assert.equal(all.reduce((s,x)=>s+BigInt(x.pendingDeltaMinor),0n),42500n);
      assert.equal((await readMerchantFinancialBalance(pool,restaurantId)).pendingMinor,'42500');
      assert.ok(all.every(x=>/^\d{4}-\d{2}-\d{2}T/.test(x.recordedAt)));
      assert.equal(first.withdrawalsAuthorized,false);
      assert.equal(first.balanceAvailableMinor,'0');
      assert.equal(first.source,'internal_accounting_only');
      assert.ok(Object.isFrozen(first.entries));
      assert.ok(first.entries.every(Object.isFrozen));
      const other=await readMerchantLedgerStatement(pool,otherRestaurant);
      assert.equal(other.entries.length,1);
      assert.ok(!orders.includes(other.entries[0].orderId));
      const empty=await readMerchantLedgerStatement(pool,randomUUID());
      assert.deepEqual(empty.entries,[]);
      assert.equal(empty.hasMore,false);
      for(const cursor of ['!!!',Buffer.from('[]').toString('base64url'),
        Buffer.from(JSON.stringify(['invalid',randomUUID(),'allocation_held']))
          .toString('base64url')]){
        await assert.rejects(readMerchantLedgerStatement(pool,restaurantId,{cursor}),
          e=>e instanceof FinanceError&&e.code==='FINANCE_STATEMENT_CURSOR_INVALID');
      }
      for(const limit of [0,101,1.5]){
        await assert.rejects(readMerchantLedgerStatement(pool,restaurantId,{limit}),
          e=>e instanceof FinanceError&&e.code==='FINANCE_STATEMENT_LIMIT_INVALID');
      }
    }finally{await pool.end();}
  });
