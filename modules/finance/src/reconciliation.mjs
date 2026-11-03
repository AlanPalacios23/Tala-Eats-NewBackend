/**
 * Module 3 FINANZAS: strictly INTERNAL, read-only journal reconciliation.
 * It does not query processors, mark payments paid or release any funds.
 * Scope is one finite batch of accounting entries in the LAB database.
 */
import {FinanceError,financeSnapshotHash,proposeHeldAllocation,requireId}
  from './ledger.mjs';

const LAB=new Set(['tala_finance_v2_test','tala_finance_v2_lab']);
const SIGNATURE=/^[a-f0-9]{64}$/;
const asLineTuple=l=>[l.accountCode,l.partyId??null,l.side,l.amountMinor];
const sortedLineTuples=lines=>JSON.stringify(lines.map(asLineTuple).sort((a,b)=>
  a[0].localeCompare(b[0])));

export async function auditInternalLedger(pool,{limit=50,orderIds}={}){
  if(!Number.isInteger(limit)||limit<1||limit>100)
    throw new FinanceError('FINANCE_AUDIT_LIMIT_INVALID');
  if(orderIds!==undefined&&(!Array.isArray(orderIds)||orderIds.length===0||
     orderIds.length>100))
    throw new FinanceError('FINANCE_AUDIT_SCOPE_INVALID');
  let scoped=null;
  if(orderIds!==undefined){
    try{scoped=orderIds.map(requireId);}
    catch{throw new FinanceError('FINANCE_AUDIT_SCOPE_INVALID');}
  }
  const c=await pool.connect();
  try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='10000ms'");
    const db=await c.query('SELECT current_database() AS name');
    if(!LAB.has(db.rows[0]?.name))throw new FinanceError('FINANCE_LAB_ONLY');
    const res=await c.query(`
      SELECT id,order_id,restaurant_id,event_key,snapshot_hash,snapshot,
        lines,kind,currency FROM tala_finance_v2.journals
      WHERE ($1::uuid[] IS NULL OR order_id=ANY($1::uuid[]))
      ORDER BY recorded_at,id LIMIT $2`,[scoped,limit]);
    const results=res.rows.map(row=>{
      const anomalies=[];
      let total='0';
      try{
        const proposal=proposeHeldAllocation({
          orderId:row.order_id,restaurantId:row.restaurant_id,snapshot:row.snapshot,
          commandKey:'finance-audit-v1-00000001'
        });
        const expectedHash=financeSnapshotHash(row.order_id,row.restaurant_id,row.snapshot);
        total=proposal.snapshot.totalMinor;
        if(row.snapshot_hash!==expectedHash)
          anomalies.push('SNAPSHOT_HASH_MISMATCH');
        if(sortedLineTuples(row.lines)!==sortedLineTuples(proposal.lines))
          anomalies.push('ALLOCATION_LINES_MISMATCH');
        if(row.kind!=='allocation_held'||row.currency!=='MXN'||
           !SIGNATURE.test(row.event_key))
          anomalies.push('JOURNAL_CONTRACT_INVALID');
      }catch{
        anomalies.push('JOURNAL_CONTRACT_INVALID');
      }
      return Object.freeze({journalId:row.id,orderId:row.order_id,
        state:anomalies.length?'needs_review':'held_internally_consistent',
        anomalies:Object.freeze(anomalies),totalMinor:total,
        availableMinor:'0'});
    });
    await c.query('COMMIT');
    return Object.freeze({scope:scoped?'explicit_orders':'first_batch_only',
      limit,examined:results.length,
      consistent:results.filter(x=>x.state==='held_internally_consistent').length,
      needsReview:results.filter(x=>x.state==='needs_review').length,
      externallyReconciled:false,withdrawalsAuthorized:false,
      entries:Object.freeze(results)});
  }catch(error){
    await c.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{c.release();}
}
