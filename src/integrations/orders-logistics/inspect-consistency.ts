/** Internal, read-only cross-module consistency audit.
 * This reports discrepancy; it never repairs or changes drivers automatically.
 * Do not expose as a public endpoint or log raw driver identifiers.
 */
import type {Pool} from 'pg';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type DispatchConsistency=Readonly<{
  orderId:string;
  status:'CONSISTENT'|'NO_ACTIVE_RESERVATION'|'ORDER_MISSING'|
    'ORDER_NOT_ASSIGNED'|'MISSING_ORDER_ASSIGNMENT'|'COURIER_MISMATCH';
  logisticsCourierId?:string;
  ordersCourierId?:string;
}>;
export async function inspectDispatchConsistency(
  pool:Pool,orderId:string
):Promise<DispatchConsistency>{
  if(typeof orderId!=='string'||!uuid.test(orderId))
    throw Error('LOGISTICS_AUDIT_ORDER_INVALID');
  const canonical=orderId.toLowerCase();
  const q=await pool.query<{
    logistics_courier_id:string|null;
    orders_courier_id:string|null;
    order_status:string|null;
    order_found:boolean;
  }>(
    `SELECT d.courier_id AS logistics_courier_id,
       a.driver_id AS orders_courier_id,
       o.status AS order_status,
       o.id IS NOT NULL AS order_found
     FROM tala_logistics_v2.dispatch_reservations d
     LEFT JOIN tala_core_v2.orders o ON o.id=d.order_id
     LEFT JOIN tala_core_v2.order_driver_assignments a ON a.order_id=d.order_id
     WHERE d.order_id=$1::uuid AND d.status='reserved'`,
    [canonical]
  );
  const r=q.rows[0];
  if(!r)return {orderId:canonical,status:'NO_ACTIVE_RESERVATION'};
  const details={
    orderId:canonical,
    ...(r.logistics_courier_id?{logisticsCourierId:r.logistics_courier_id}:{}),
    ...(r.orders_courier_id?{ordersCourierId:r.orders_courier_id}:{})
  };
  if(!r.order_found)return {...details,status:'ORDER_MISSING'};
  if(r.order_status!=='assigned')return {...details,status:'ORDER_NOT_ASSIGNED'};
  if(!r.orders_courier_id)return {...details,status:'MISSING_ORDER_ASSIGNMENT'};
  if(r.orders_courier_id!==r.logistics_courier_id)
    return {...details,status:'COURIER_MISMATCH'};
  return {...details,status:'CONSISTENT'};
}
