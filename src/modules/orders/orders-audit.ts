/**
 * Read-only post-deployment checks for the ORDERS module.
 * The report contains COUNTS ONLY (no names, addresses, customer IDs or PINs).
 * Use a DB role with SELECT-only privileges, not the runtime writer.
 * This module does not alter orders or other business domains.
 */
import type {Pool,PoolClient} from 'pg';

type Row={
  id:string;version:string;status:string;fulfillment:string;
  payment_method:string;payment_status:string;
  total_minor:string;price_snapshot:Record<string,unknown>;
  line_count:string;items_sum:string|null;transition_count:string;
  missing_outbox:string;has_driver:boolean;has_cash_proof:boolean;
};
export type OrderAuditCounters={
  scanned:number;missingLines:number;invalidTotals:number;versionDrift:number;
  missingOutbox:number;missingAssignment:number;missingDeliveryProof:number;
};
export type OrderAuditReport={
  status:'PASS'|'FAIL'|'INCOMPLETE';scanned:number;hasMore:boolean;
  counters:OrderAuditCounters;
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validMinor=(v:unknown):v is string=>
  typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v);
const zero=():OrderAuditCounters=>({
  scanned:0,missingLines:0,invalidTotals:0,versionDrift:0,
  missingOutbox:0,missingAssignment:0,missingDeliveryProof:0
});
function tally(row:Row,count:OrderAuditCounters){
  count.scanned++;
  if(Number(row.line_count)===0)count.missingLines++;
  const snap=row.price_snapshot;
  const items=snap?.itemsMinor,service=snap?.serviceFeeMinor,
    delivery=snap?.deliveryFeeMinor,tip=snap?.tipMinor??'0';
  // Do not use JS floats for monetary comparisons.
  if(!validMinor(items)||!validMinor(service)||!validMinor(delivery)||
    !validMinor(tip)||!validMinor(row.total_minor)||
    row.items_sum===null||
    BigInt(items)+BigInt(service)+BigInt(delivery)+BigInt(tip)!==BigInt(row.total_minor)||
    BigInt(items)!==BigInt(row.items_sum)||
    snap?.totalMinor!==row.total_minor)count.invalidTotals++;
  if(BigInt(row.version)!==BigInt(row.transition_count))count.versionDrift++;
  if(BigInt(row.missing_outbox)>0n)count.missingOutbox++;
  if(row.fulfillment==='delivery'&&
    ['assigned','picked_up','on_the_way','delivered'].includes(row.status)&&
    !row.has_driver)count.missingAssignment++;
  if(row.status==='delivered'&&row.payment_method==='cash'&&
    (row.payment_status!=='paid'||!row.has_cash_proof))count.missingDeliveryProof++;
}
async function page(client:PoolClient,afterId:string|null,limit:number):Promise<Row[]>{
  const result=await client.query<Row>(`
    SELECT o.id,o.version,o.status,o.fulfillment,o.payment_method,
      o.payment_status,o.total_minor,o.price_snapshot,
      (SELECT count(*)::text FROM tala_core_v2.order_lines l WHERE l.order_id=o.id) AS line_count,
      (SELECT sum(l.unit_minor::numeric*l.quantity)::text
         FROM tala_core_v2.order_lines l WHERE l.order_id=o.id) AS items_sum,
      (SELECT count(*)::text FROM tala_core_v2.order_events e
         WHERE e.order_id=o.id AND e.previous_status IS DISTINCT FROM e.new_status)
         AS transition_count,
      (SELECT count(*)::text FROM tala_core_v2.order_events e
         WHERE e.order_id=o.id AND NOT EXISTS(
           SELECT 1 FROM tala_core_v2.outbox b
           WHERE b.aggregate_id=o.id AND b.event_key=e.event_key))
         AS missing_outbox,
      EXISTS(SELECT 1 FROM tala_core_v2.order_driver_assignments d
        WHERE d.order_id=o.id) AS has_driver,
      EXISTS(SELECT 1 FROM tala_core_v2.order_handoffs h WHERE h.order_id=o.id
        AND h.buyer_cash_ack_at IS NOT NULL
        AND h.custodian_cash_ack_at IS NOT NULL
        AND h.custodian_id IS NOT NULL
        AND h.pin_consumed_at IS NOT NULL
        AND h.cash_amount_minor=o.total_minor
        AND h.custodian_role=CASE WHEN o.fulfillment='pickup'
          THEN 'merchant' ELSE 'driver' END) AS has_cash_proof
    FROM tala_core_v2.orders o
    WHERE ($1::uuid IS NULL OR o.id>$1::uuid)
    ORDER BY o.id LIMIT $2`,[afterId,limit]);
  return result.rows;
}

/** Scan all orders up to an explicit bounded max; incomplete never looks green. */
export async function auditOrdersReadOnly(
  pool:Pool,opts:{maxOrders?:number;pageSize?:number}={}
):Promise<OrderAuditReport>{
  const max=opts.maxOrders??10000,size=opts.pageSize??100;
  if(!Number.isSafeInteger(max)||max<1||max>100000||
    !Number.isSafeInteger(size)||size<1||size>500)
    throw Error('ORDERS_AUDIT_OPTIONS_INVALID');
  const client=await pool.connect();
  let transaction=false;
  try{
    // Explicit READ ONLY and consistent snapshot. No advisory locks, DML,
    // or external callbacks are executed by the audit.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction=true;
    await client.query("SET LOCAL statement_timeout='12000ms'");
    await client.query("SET LOCAL lock_timeout='1000ms'");
    const counters=zero();
    let last:string|null=null,more=false;
    while(counters.scanned<max){
      const requested=Math.min(size,max-counters.scanned);
      const rows=await page(client,last,requested);
      for(const row of rows){
        tally(row,counters);
        last=row.id;
      }
      if(rows.length<requested)break;
    }
    // Distinguish an exact-size scan from a partial scan at the upper bound.
    if(counters.scanned===max)more=(await page(client,last,1)).length!==0;
    await client.query('COMMIT');transaction=false;
    const issues=Object.entries(counters)
      .filter(([key])=>key!=='scanned')
      .some(([,value])=>value>0);
    return {status:more?'INCOMPLETE':issues?'FAIL':'PASS',
      scanned:counters.scanned,hasMore:more,counters};
  }catch(error){
    if(transaction)await client.query('ROLLBACK');
    throw error;
  }finally{client.release();}
}
