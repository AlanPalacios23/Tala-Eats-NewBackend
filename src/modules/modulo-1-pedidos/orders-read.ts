/** Read-only Orders projections: permissioned details, public lifecycle and buyer receipt.
 * No logistics, finance, payment providers, PINs or internal outbox payloads.
 */
import type {Pool} from 'pg';
import {OrderServiceError} from './checkout.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Role='customer'|'merchant'|'driver';

export type OrderHistoryEntry={
  from:string|null;to:string;occurredAt:string;
};
export type OrderTimeline={
  orderId:string;status:string;version:string;history:OrderHistoryEntry[];
};
export async function readOrderTimeline(
  pool:Pool,actorId:string,actorRole:Role,orderId:string
):Promise<OrderTimeline>{
  if(!uuid.test(actorId)||!uuid.test(orderId)||
    !['customer','merchant','driver'].includes(actorRole))
    throw new OrderServiceError('ORDER_INVALID');
  // One statement supplies both current state and history from the same MVCC
  // snapshot. SQL authorization prevents existence leaks between roles.
  // Only actual state transitions are public. Hide event payload, PIN, cash
  // attestations, audit actor IDs, idempotency keys and private outbox data.
  const result=await pool.query<{
    id:string;status:string;version:string;history:OrderHistoryEntry[];
  }>(`
    SELECT o.id,o.status,o.version,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'from',e.previous_status,'to',e.new_status,
          'occurredAt',e.occurred_at
        ) ORDER BY e.id)
        FROM tala_core_v2.order_events e
        WHERE e.order_id=o.id
          AND e.previous_status IS DISTINCT FROM e.new_status
      ),'[]'::jsonb) AS history
    FROM tala_core_v2.orders o
    WHERE o.id=$1::uuid AND (
      ($3::text='customer' AND o.buyer_id=$2::uuid)
      OR ($3::text='merchant' AND EXISTS (
        SELECT 1 FROM tala_core_v2.restaurant_memberships m
        WHERE m.restaurant_id=o.restaurant_id AND m.member_id=$2::uuid
          AND m.is_active=true
      ))
      OR ($3::text='driver' AND EXISTS (
        SELECT 1 FROM tala_core_v2.order_driver_assignments d
        JOIN tala_core_v2.driver_profiles p ON p.account_id=d.driver_id
        JOIN tala_core_v2.accounts a ON a.id=d.driver_id
        WHERE d.order_id=o.id AND d.driver_id=$2::uuid AND p.approved=true
          AND a.is_active=true AND a.role='driver'
      ))
    )`,[orderId,actorId,actorRole]);
  const row=result.rows[0];
  if(!row)throw new OrderServiceError('ORDER_NOT_FOUND');
  return {orderId:row.id,status:row.status,version:row.version,history:row.history};
}

export type OrderReceipt={
  orderId:string;status:string;paymentMethod:string;paymentStatus:string;
  currency:string;fulfillment:string;itemsMinor:string;serviceFeeMinor:string;
  deliveryFeeMinor:string;tipMinor:string;totalMinor:string;
  lines:{name:string;quantity:number;unitMinor:string;lineTotalMinor:string}[];
};

const isMinor=(value:unknown):value is string=>
  typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value);

export async function readBuyerReceipt(
  pool:Pool,buyerId:string,orderId:string
):Promise<OrderReceipt>{
  if(!uuid.test(buyerId)||!uuid.test(orderId))
    throw new OrderServiceError('ORDER_INVALID');
  // Consistent SQL snapshot: never reprice with the current catalog and never
  // leak merchant commission, internal driver pay or platform margins.
  const result=await pool.query<{
    id:string;status:string;payment_method:string;payment_status:string;
    currency:string;fulfillment:string;total_minor:string;
    price_snapshot:Record<string,unknown>;
    lines:{name:string;quantity:number;unitMinor:string}[];
  }>(`
    SELECT o.id,o.status,o.payment_method,o.payment_status,o.currency,
      o.fulfillment,o.total_minor,o.price_snapshot,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'name',l.product_name_snapshot,'quantity',l.quantity,
          'unitMinor',l.unit_minor::text
        ) ORDER BY l.line_number)
        FROM tala_core_v2.order_lines l WHERE l.order_id=o.id
      ),'[]'::jsonb) AS lines
    FROM tala_core_v2.orders o
    WHERE o.id=$1::uuid AND o.buyer_id=$2::uuid`,[orderId,buyerId]);
  const row=result.rows[0];
  if(!row)throw new OrderServiceError('ORDER_NOT_FOUND');
  const snapshot=row.price_snapshot;
  const items=snapshot?.itemsMinor,service=snapshot?.serviceFeeMinor,
    delivery=snapshot?.deliveryFeeMinor,tip=snapshot?.tipMinor??'0';
  if(!isMinor(row.total_minor)||!isMinor(items)||!isMinor(service)||
    !isMinor(delivery)||!isMinor(tip)||row.lines.length===0||
    !row.lines.every(line=>Number.isSafeInteger(line.quantity)&&
      line.quantity>0&&isMinor(line.unitMinor)))
    throw new OrderServiceError('RECEIPT_UNAVAILABLE');
  const lines=row.lines.map(line=>({
    name:line.name,quantity:line.quantity,unitMinor:line.unitMinor,
    lineTotalMinor:(BigInt(line.unitMinor)*BigInt(line.quantity)).toString()
  }));
  if(lines.reduce((sum,line)=>sum+BigInt(line.lineTotalMinor),0n)!==BigInt(items)||
    BigInt(items)+BigInt(service)+BigInt(delivery)+BigInt(tip)!==BigInt(row.total_minor))
    throw new OrderServiceError('RECEIPT_UNAVAILABLE');
  return {
    orderId:row.id,status:row.status,paymentMethod:row.payment_method,
    paymentStatus:row.payment_status,currency:row.currency,
    fulfillment:row.fulfillment,itemsMinor:items,serviceFeeMinor:service,
    deliveryFeeMinor:delivery,tipMinor:tip,totalMinor:row.total_minor,lines
  };
}
