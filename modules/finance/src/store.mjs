/**
 * TALA EATS CORE v2 — independent FINANZAS LAB accounting journal.
 * No provider SDK or HTTP endpoints; this does not prove a customer paid.
 * A trusted future module must authorize every source fact before calling.
 */
import {FinanceError,proposeHeldAllocation,proposeFullHeldReversal,requireId} from './ledger.mjs';
import {createHash} from 'node:crypto';

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


/**
 * Compensate a HELD accounting allocation in full, append-only.
 * This is an INTERNAL LAB correction, never an external refund.
 * Exactly one reversal per original allocation, including under concurrent
 * requests. The source journal remains unchanged and auditable.
 */
export async function reverseLabHeldAllocation(pool,{orderId,commandKey}={}){
  const order=requireId(orderId);
  return tx(pool,false,async c=>{
    const src=await c.query(`
      SELECT id,order_id,restaurant_id,snapshot,snapshot_hash,lines
      FROM tala_finance_v2.journals WHERE order_id=$1::uuid
      AND kind='allocation_held' FOR UPDATE`,[order]);
    if(src.rowCount!==1)throw new FinanceError('FINANCE_ALLOCATION_NOT_FOUND');
    const base=src.rows[0];
    const j=proposeFullHeldReversal({
      originalJournalId:base.id,orderId:base.order_id,
      restaurantId:base.restaurant_id,snapshot:base.snapshot,
      snapshotHash:base.snapshot_hash,originalLines:base.lines,commandKey
    });
    const existing=await c.query(`
      SELECT id,original_journal_id,order_id,restaurant_id,event_key,
        snapshot_hash,lines
      FROM tala_finance_v2.held_reversals WHERE original_journal_id=$1::uuid
      OR event_key=$2 FOR UPDATE`,[j.originalJournalId,j.eventKey]);
    if(existing.rowCount){
      if(existing.rowCount!==1)throw new FinanceError('FINANCE_REVERSAL_CONFLICT');
      const old=existing.rows[0];
      if(old.original_journal_id!==j.originalJournalId||
         old.order_id!==j.orderId||old.restaurant_id!==j.restaurantId)
        throw new FinanceError('FINANCE_IDEMPOTENCY_CONFLICT');
      if(old.event_key!==j.eventKey)
        throw new FinanceError('FINANCE_ALREADY_REVERSED');
      if(old.snapshot_hash!==j.snapshotHash||
         JSON.stringify(old.lines.map(x=>[x.accountCode,x.partyId??null,x.side,x.amountMinor]))!==
         JSON.stringify(j.lines.map(x=>[x.accountCode,x.partyId??null,x.side,x.amountMinor])))
        throw new FinanceError('FINANCE_REVERSAL_CONFLICT');
      return Object.freeze({orderId:order,originalJournalId:j.originalJournalId,
        reversalId:old.id,status:'fully_reversed',replayed:true});
    }
    const inserted=await c.query(`
      INSERT INTO tala_finance_v2.held_reversals
        (original_journal_id,order_id,restaurant_id,event_key,snapshot_hash,currency,lines)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,'MXN',$6::jsonb)
      RETURNING id`,[
      j.originalJournalId,j.orderId,j.restaurantId,j.eventKey,j.snapshotHash,
      JSON.stringify(j.lines)
    ]);
    return Object.freeze({orderId:order,originalJournalId:j.originalJournalId,
      reversalId:inserted.rows[0].id,status:'fully_reversed',replayed:false});
  });
}


const STATEMENT_KINDS=new Set(['allocation_held','full_held_reversal']);
const EXACT_TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
function decodeStatementCursor(cursor){
  if(cursor===null||cursor===undefined)return null;
  if(typeof cursor!=='string'||cursor.length>300||!(/^[A-Za-z0-9_-]+$/).test(cursor))
    throw new FinanceError('FINANCE_STATEMENT_CURSOR_INVALID');
  try{
    const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
    if(!Array.isArray(value)||value.length!==3||
       typeof value[0]!=='string'||!EXACT_TIME.test(value[0])||
       !Number.isFinite(Date.parse(value[0]))||
       !STATEMENT_KINDS.has(value[2]))
      throw Error('CURSOR_INVALID');
    return [value[0],requireId(value[1]),value[2]];
  }catch{
    throw new FinanceError('FINANCE_STATEMENT_CURSOR_INVALID');
  }
}
/**
 * Internal accounting statement for ONE restaurant. Purely pending movements
 * from HELD entries and full compensations. No financial transfer semantics.
 * Keyset pagination preserves PostgreSQL's microsecond timestamp precision.
 */
export async function readMerchantLedgerStatement(pool,restaurantId,{
  limit=25,cursor=null
}={}){
  const merchant=requireId(restaurantId);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)
    throw new FinanceError('FINANCE_STATEMENT_LIMIT_INVALID');
  const key=decodeStatementCursor(cursor);
  return tx(pool,true,async c=>{
    const rows=await c.query(`
      WITH movements AS (
        SELECT id,recorded_at,order_id,restaurant_id,
          'allocation_held'::text AS entry_kind,
          (snapshot->>'merchantPayableMinor')::bigint AS delta_minor
        FROM tala_finance_v2.journals
        UNION ALL
        SELECT r.id,r.recorded_at,r.order_id,r.restaurant_id,
          'full_held_reversal'::text AS entry_kind,
          -(j.snapshot->>'merchantPayableMinor')::bigint AS delta_minor
        FROM tala_finance_v2.held_reversals r
        JOIN tala_finance_v2.journals j ON j.id=r.original_journal_id
      )
      SELECT id,order_id,entry_kind,delta_minor::text AS delta_minor,
        to_char(recorded_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_time
      FROM movements WHERE restaurant_id=$1::uuid
        AND ($2::timestamptz IS NULL
          OR (recorded_at,id,entry_kind)<($2::timestamptz,$3::uuid,$4::text))
      ORDER BY recorded_at DESC,id DESC,entry_kind DESC
      LIMIT $5`,[merchant,key?.[0]??null,key?.[1]??null,key?.[2]??null,limit+1]);
    const hasMore=rows.rows.length>limit;
    const page=rows.rows.slice(0,limit);
    const entries=page.map(r=>Object.freeze({
      entryId:r.id,orderId:r.order_id,kind:r.entry_kind,
      recordedAt:r.exact_time,pendingDeltaMinor:r.delta_minor
    }));
    const last=page[page.length-1];
    const nextCursor=hasMore
      ?Buffer.from(JSON.stringify([last.exact_time,last.id,last.entry_kind]))
        .toString('base64url'):null;
    return Object.freeze({
      restaurantId:merchant,currency:'MXN',source:'internal_accounting_only',
      balanceAvailableMinor:'0',withdrawalsAuthorized:false,
      entries:Object.freeze(entries),hasMore,nextCursor
    });
  });
}


/**
 * FINANZAS-only LAB auxiliary ownership of a pre-existing driver HELD share.
 * The caller is an internal TEST fixture: this does NOT validate M2 delivery,
 * employee identity, cash custody, earned money, or an external payout.
 * Assigning a claim cannot change the general ledger or create new value.
 */
export async function assignLabDriverHeldClaim(pool,{
  orderId,driverId,commandKey
}={}){
  const order=requireId(orderId),driver=requireId(driverId);
  if(typeof commandKey!=='string'||!/^[A-Za-z0-9_.:-]{16,128}$/.test(commandKey))
    throw new FinanceError('FINANCE_COMMAND_INVALID');
  const eventKey=createHash('sha256')
    .update('finance.driver-held-claim.v1|'+order+'|'+commandKey).digest('hex');
  return tx(pool,false,async c=>{
    const source=await c.query(`
      SELECT j.id,j.order_id,j.restaurant_id,j.snapshot,
        EXISTS (SELECT 1 FROM tala_finance_v2.held_reversals r
          WHERE r.original_journal_id=j.id) AS reversed
      FROM tala_finance_v2.journals j
      WHERE j.order_id=$1::uuid AND j.kind='allocation_held'
      FOR UPDATE OF j`,[order]);
    if(source.rowCount!==1)
      throw new FinanceError('FINANCE_ALLOCATION_NOT_FOUND');
    const j=source.rows[0];
    if(j.reversed)throw new FinanceError('FINANCE_ALREADY_REVERSED');
    if(j.snapshot?.fulfillment!=='delivery'||
       !/^[1-9][0-9]*$/.test(j.snapshot?.driverPayableMinor??''))
      throw new FinanceError('FINANCE_NO_DRIVER_HELD');
    const minor=j.snapshot.driverPayableMinor;
    const inserted=await c.query(`
      INSERT INTO tala_finance_v2.driver_held_claims
       (original_journal_id,order_id,restaurant_id,driver_id,amount_minor,event_key)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6)
      ON CONFLICT DO NOTHING RETURNING id`,
      [j.id,order,j.restaurant_id,driver,minor,eventKey]);
    if(inserted.rowCount)return Object.freeze({
      orderId:order,driverId:driver,claimId:inserted.rows[0].id,
      heldMinor:minor,replayed:false,availableMinor:'0'
    });
    const existing=await c.query(`
      SELECT id,original_journal_id,order_id,driver_id,event_key,
        amount_minor::text AS amount_minor
      FROM tala_finance_v2.driver_held_claims
      WHERE order_id=$1::uuid OR event_key=$2 FOR UPDATE`,
      [order,eventKey]);
    if(existing.rowCount!==1)
      throw new FinanceError('FINANCE_DRIVER_CLAIM_CONFLICT');
    const old=existing.rows[0];
    if(old.order_id!==order||old.original_journal_id!==j.id||
       old.driver_id!==driver||old.event_key!==eventKey||
       old.amount_minor!==minor)
      throw new FinanceError('FINANCE_DRIVER_CLAIM_CONFLICT');
    return Object.freeze({
      orderId:order,driverId:driver,claimId:old.id,
      heldMinor:minor,replayed:true,availableMinor:'0'
    });
  });
}

/** Driver pending is only attributed, not delivered/earned/withdrawable. */
export async function readDriverHeldBalance(pool,driverId){
  const id=requireId(driverId);
  return tx(pool,true,async c=>{
    const r=await c.query(`
      SELECT pending_minor::text FROM tala_finance_v2.driver_held_balances
      WHERE driver_id=$1::uuid`,[id]);
    return Object.freeze({driverId:id,currency:'MXN',
      pendingHeldMinor:r.rows[0]?.pending_minor??'0',
      availableMinor:'0',withdrawable:false,
      source:'internal_accounting_only'});
  });
}
