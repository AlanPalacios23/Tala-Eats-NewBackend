/**
 * TALA EATS CORE v2 — independent FINANZAS LAB accounting journal.
 * No provider SDK or HTTP endpoints; this does not prove a customer paid.
 * A trusted future module must authorize every source fact before calling.
 */
import {FinanceError,proposeHeldAllocation,requireId} from './ledger.mjs';

const LAB=new Set(['tala_finance_v2_test','tala_finance_v2_lab']);
const tx=async(pool,readOnly,work)=>{
  const c=await pool.connect();
  try{
    await c.query(readOnly?'BEGIN READ ONLY':'BEGIN');
    await c.query("SET LOCAL lock_timeout='3000ms'");
    await c.query("SET LOCAL statement_timeout='10000ms'");
    const d=await c.query('SELECT current_database() AS name');
    if(!LAB.has(d.rows[0]?.name))throw new FinanceError('FINANCE_LAB_ONLY');
    const value=await work(c);
    await c.query('COMMIT');
    return value;
  }catch(error){
    await c.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{c.release();}
};

/**
 * Record one accounting allocation in a disposable LAB DB. This proposal is
 * not a payment, nor merchant/driver earnings available for withdrawal.
 * Command keys serialize retries; one held allocation per order, always.
 */
export async function recordLabHeldAllocation(pool,input){
  const j=proposeHeldAllocation(input);
  return tx(pool,false,async c=>{
    const args=[j.orderId,j.restaurantId,j.eventKey,j.snapshotHash,
      JSON.stringify(j.snapshot),JSON.stringify(j.lines)];
    const inserted=await c.query(`
      INSERT INTO tala_finance_v2.journals
        (order_id,restaurant_id,kind,event_key,snapshot_hash,currency,snapshot,lines)
      VALUES($1::uuid,$2::uuid,'allocation_held',$3,$4,'MXN',$5::jsonb,$6::jsonb)
      ON CONFLICT DO NOTHING RETURNING id`,args);
    if(inserted.rowCount){
      return Object.freeze({orderId:j.orderId,journalId:inserted.rows[0].id,
        status:'held',replayed:false});
    }
    const prev=await c.query(`
      SELECT id,order_id,event_key,restaurant_id,snapshot_hash,
        snapshot=$3::jsonb AS snapshot_matches,
        lines=$4::jsonb AS lines_match
      FROM tala_finance_v2.journals
      WHERE order_id=$1::uuid OR event_key=$2 FOR UPDATE`,
      [j.orderId,j.eventKey,JSON.stringify(j.snapshot),JSON.stringify(j.lines)]);
    if(prev.rows.length!==1)throw new FinanceError('FINANCE_JOURNAL_CONFLICT');
    const old=prev.rows[0];
    if(old.order_id!==j.orderId)throw new FinanceError('FINANCE_IDEMPOTENCY_CONFLICT');
    if(old.event_key!==j.eventKey)throw new FinanceError('FINANCE_ORDER_ALREADY_ALLOCATED');
    if(old.restaurant_id!==j.restaurantId||
       old.snapshot_hash!==j.snapshotHash||
       old.snapshot_matches!==true||old.lines_match!==true)
      throw new FinanceError('FINANCE_IDEMPOTENCY_CONFLICT');
    return Object.freeze({orderId:j.orderId,journalId:old.id,status:'held',
      replayed:true});
  });
}

/** Preview, never a payout authorization or a promise of liquidity. */
export async function readMerchantFinancialBalance(pool,restaurantId){
  const id=requireId(restaurantId);
  return tx(pool,true,async c=>{
    const r=await c.query(`
      SELECT pending_minor::text,available_minor::text
      FROM tala_finance_v2.merchant_pending_balances
      WHERE restaurant_id=$1::uuid`,[id]);
    return Object.freeze({restaurantId:id,currency:'MXN',
      pendingMinor:r.rows[0]?.pending_minor??'0',
      availableMinor:'0',withdrawable:false,source:'internal_accounting_only'});
  });
}
