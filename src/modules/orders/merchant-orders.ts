/**
 * CORE v2 / PEDIDOS: transactional merchant lifecycle command.
 * Internal service only: NO HTTP routes, auth sessions, or LIVE connections.
 *
 * Caller MUST obtain actorId from verified backend auth, not from the
 * request body, and must provision memberships through a trusted workflow.
 */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {OrderTransitionError, transitionOrder} from './order-machine.ts';
import type {Fulfillment, OrderStatus, PaymentMethod} from './order-machine.js';

export type MerchantOrderAction = 'confirmed' | 'preparing' | 'ready';
export type MerchantOrderCommand = {
  orderId: string;
  actorId: string;
  /** Stable key for ONE user action, reused only for an identical retry. */
  commandKey: string;
  /** Obtained from a fresh read, not chosen by the server. */
  expectedVersion: bigint;
  target: MerchantOrderAction;
};
export type MerchantOrderResult = {
  orderId: string;
  status: OrderStatus;
  version: bigint;
  /** Whether this exact action was committed earlier. */
  replayed: boolean;
};
export class MerchantOrderError extends Error {
  readonly code:string;
  constructor(code:string) {
    super(code);
    this.code=code;
    this.name='MerchantOrderError';
  }
}
type LockedOrder = {
  id: string;
  status: OrderStatus;
  fulfillment: Fulfillment;
  payment_method: PaymentMethod;
  payment_status: string;
  version: string;
};
type StoredEvent = {
  new_status: OrderStatus;
  actor_id: string|null;
  data: {target?:string;expectedVersion?:string}|null;
};
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMAND_RE=/^[a-zA-Z0-9_.:-]{16,128}$/;

export function merchantEventKey(command:MerchantOrderCommand):string {
  return createHash('sha256').update(
    'merchant-order-v1|'+command.orderId+'|'+command.actorId+'|'+command.commandKey
  ).digest('hex');
}
export async function advanceMerchantOrder(pool:Pool,command:MerchantOrderCommand):Promise<MerchantOrderResult> {
  if (!UUID_RE.test(command.orderId)||!UUID_RE.test(command.actorId)
    ||!COMMAND_RE.test(command.commandKey)
    ||typeof command.expectedVersion!=='bigint'||command.expectedVersion<1n
    ||!['confirmed','preparing','ready'].includes(command.target)) {
    throw new MerchantOrderError('COMMAND_INVALID');
  }
  const eventKey=merchantEventKey(command);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Acquire locks in consistent order (order first, membership second).
    // Cancellation uses the same order, avoiding lock inversions/deadlocks.
    const result=await client.query<LockedOrder & {restaurant_id:string}>(`
      SELECT id,restaurant_id,status,fulfillment,payment_method,payment_status,version
      FROM tala_core_v2.orders WHERE id=$1::uuid FOR UPDATE`,[command.orderId]);
    const order=result.rows[0];
    if(!order)throw new MerchantOrderError('ORDER_NOT_FOUND_OR_FORBIDDEN');
    const membership=await client.query(`
      SELECT 1 FROM tala_core_v2.restaurant_memberships
      WHERE restaurant_id=$1::uuid AND member_id=$2::uuid AND is_active=true
      FOR SHARE`,[order.restaurant_id,command.actorId]);
    if(!membership.rowCount)throw new MerchantOrderError('ORDER_NOT_FOUND_OR_FORBIDDEN');

    const previous=await client.query<StoredEvent>(`
      SELECT new_status,actor_id,data
      FROM tala_core_v2.order_events
      WHERE order_id=$1::uuid AND event_key=$2`,[command.orderId,eventKey]);
    const prior=previous.rows[0];
    if(prior){
      if(prior.actor_id!==command.actorId
        ||prior.new_status!==command.target
        ||prior.data?.target!==command.target
        ||prior.data.expectedVersion!==String(command.expectedVersion)) {
        throw new MerchantOrderError('IDEMPOTENCY_CONFLICT');
      }
      await client.query('COMMIT');
      return {orderId:order.id,status:order.status,version:BigInt(order.version),replayed:true};
    }
    if(BigInt(order.version)!==command.expectedVersion){
      throw new MerchantOrderError('ORDER_VERSION_CONFLICT');
    }
    if(order.payment_method==='stripe'&&order.payment_status!=='paid'){
      throw new MerchantOrderError('PAYMENT_NOT_VERIFIED');
    }
    if(order.payment_method==='cash'&&!['pending','paid'].includes(order.payment_status)){
      throw new MerchantOrderError('PAYMENT_NOT_ALLOWED');
    }
    try {
      transitionOrder({
        current:order.status,target:command.target,fulfillment:order.fulfillment,
        paymentMethod:order.payment_method,actor:'merchant',
        paymentVerified:order.payment_status==='paid'
      });
    }catch(error){
      if(error instanceof OrderTransitionError)throw new MerchantOrderError(error.code);
      throw error;
    }
    const updated=await client.query<{status:OrderStatus;version:string}>(`
      UPDATE tala_core_v2.orders
      SET status=$2,version=version+1,updated_at=now()
      WHERE id=$1::uuid AND version=$3::bigint
      RETURNING status,version`,
      [command.orderId,command.target,String(command.expectedVersion)]);
    const next=updated.rows[0];
    if(!next)throw new MerchantOrderError('ORDER_VERSION_CONFLICT');

    const eventData={
      target:command.target,expectedVersion:String(command.expectedVersion),
      resultVersion:next.version
    };
    await client.query(`
      INSERT INTO tala_core_v2.order_events
        (order_id,event_key,previous_status,new_status,actor_role,actor_id,data)
      VALUES ($1::uuid,$2,$3,$4,'merchant',$5::uuid,$6::jsonb)`,
      [command.orderId,eventKey,order.status,command.target,command.actorId,JSON.stringify(eventData)]);
    // Same transaction; never emit notifications before commit.
    await client.query(`
      INSERT INTO tala_core_v2.outbox
        (aggregate_id,event_key,event_type,payload)
      VALUES ($1::uuid,$2,'order.status.changed',$3::jsonb)`,
      [command.orderId,eventKey,JSON.stringify({
        orderId:command.orderId,from:order.status,to:command.target,version:next.version
      })]);
    await client.query('COMMIT');
    return {orderId:order.id,status:next.status,version:BigInt(next.version),replayed:false};
  }catch(error){
    await client.query('ROLLBACK');
    throw error;
  }finally{
    client.release();
  }
}
