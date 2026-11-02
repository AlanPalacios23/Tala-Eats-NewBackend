/** Cancel CASH orders only before fulfillment. Stock restoration is atomic. */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {OrderServiceError} from './checkout.ts';
import {OrderTransitionError,transitionOrder} from './order-machine.ts';
import type {OrderStatus} from './order-machine.ts';
export type CancelCommand={orderId:string;actorId:string;actor:'customer'|'merchant';commandKey:string;expectedVersion:bigint};
export type CancelResult={orderId:string;status:'cancelled';version:bigint;replayed:boolean};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function cancelCashOrder(pool:Pool,cmd:CancelCommand):Promise<CancelResult>{
  if(!uuid.test(cmd.orderId)||!uuid.test(cmd.actorId)||!['customer','merchant'].includes(cmd.actor)
    ||!/^[a-zA-Z0-9_.:-]{16,128}$/.test(cmd.commandKey)
    ||typeof cmd.expectedVersion!=='bigint'||cmd.expectedVersion<1n)
    throw new OrderServiceError('COMMAND_INVALID');
  const key=createHash('sha256').update(
    ['order.cancel.v1',cmd.orderId.toLowerCase(),cmd.actor,cmd.actorId.toLowerCase(),cmd.commandKey].join('|')).digest('hex');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    // Bound lock waits and queries; never leave a checkout/cancellation hanging.
    // SET LOCAL is automatically rolled back or reset at COMMIT.
    await client.query("SET LOCAL lock_timeout = '3000ms'");
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15000ms'");
    const r=await client.query<{id:string;status:string;buyer_id:string;restaurant_id:string;
      fulfillment:'pickup'|'delivery';payment_method:'cash'|'stripe';
      payment_status:string;version:string}>(`
      SELECT * FROM tala_core_v2.orders WHERE id=$1::uuid FOR UPDATE`,[cmd.orderId]);
    const order=r.rows[0];
    if(!order)throw new OrderServiceError('ORDER_NOT_FOUND');
    if(cmd.actor==='customer'){
      if(order.buyer_id!==cmd.actorId)throw new OrderServiceError('ORDER_NOT_FOUND');
    }else{
      const rights=await client.query(`
        SELECT 1 FROM tala_core_v2.restaurant_memberships
        WHERE restaurant_id=$1::uuid AND member_id=$2::uuid AND is_active=true
        FOR SHARE`,
        [order.restaurant_id,cmd.actorId]);
      if(!rights.rowCount)throw new OrderServiceError('ORDER_NOT_FOUND');
    }
    const events=await client.query<{actor_id:string;data:{expectedVersion?:string}}>(`
      SELECT actor_id,data FROM tala_core_v2.order_events
      WHERE order_id=$1::uuid AND event_key=$2`,[cmd.orderId,key]);
    const previous=events.rows[0];
    if(previous){
      if(previous.actor_id!==cmd.actorId||previous.data?.expectedVersion!==String(cmd.expectedVersion))
        throw new OrderServiceError('IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT');
      return {orderId:order.id,status:'cancelled',version:BigInt(order.version),replayed:true};
    }
    if(BigInt(order.version)!==cmd.expectedVersion)
      throw new OrderServiceError('ORDER_VERSION_CONFLICT');
    if(order.payment_method!=='cash'||order.payment_status!=='pending')
      throw new OrderServiceError('FINANCIAL_COMPENSATION_REQUIRED');
    // Both the order state machine and the service enforce the same policy.
    // The inventory restitution follows in THIS transaction. Any SQL failure
    // rolls back both compensation and cancellation atomically.
    if(!(cmd.actor==='customer'?order.status==='received':
      ['received','confirmed'].includes(order.status)))
      throw new OrderServiceError('CANCELLATION_NOT_ALLOWED');
    try{
      transitionOrder({
        current:order.status as OrderStatus,target:'cancelled',
        fulfillment:order.fulfillment,paymentMethod:order.payment_method,
        actor:cmd.actor,cancellationCleared:true
      });
    }catch(error){
      if(error instanceof OrderTransitionError)
        throw new OrderServiceError(error.code);
      throw error;
    }
    const lines=await client.query<{product_id:string;quantity:number}>(`
      SELECT product_id,quantity FROM tala_core_v2.order_lines
      WHERE order_id=$1::uuid ORDER BY product_id`,[cmd.orderId]);
    if(!lines.rows.length)throw new OrderServiceError('ORDER_LINES_MISSING');
    for(const line of lines.rows){
      const result=await client.query(`
        UPDATE tala_core_v2.catalog_products SET stock=stock+$2,updated_at=now()
        WHERE id=$1::uuid RETURNING id`,[line.product_id,line.quantity]);
      if(result.rowCount!==1)throw new OrderServiceError('PRODUCT_NOT_FOUND');
    }
    const next=await client.query<{version:string}>(`
      UPDATE tala_core_v2.orders SET status='cancelled',version=version+1,updated_at=now()
      WHERE id=$1::uuid AND version=$2::bigint RETURNING version`,
      [cmd.orderId,String(cmd.expectedVersion)]);
    if(!next.rows[0])throw new OrderServiceError('ORDER_VERSION_CONFLICT');
    await client.query(`
      INSERT INTO tala_core_v2.order_events
        (order_id,event_key,previous_status,new_status,actor_role,actor_id,data)
      VALUES($1::uuid,$2,$3,'cancelled',$4,$5::uuid,$6::jsonb)`,
      [order.id,key,order.status,cmd.actor,cmd.actorId,
        JSON.stringify({expectedVersion:String(cmd.expectedVersion),restocked:true,actor:cmd.actor})]);
    await client.query(`
      INSERT INTO tala_core_v2.outbox(aggregate_id,event_key,event_type,payload)
      VALUES($1::uuid,$2,'order.cancelled',$3::jsonb)`,[order.id,key,JSON.stringify({
        orderId:order.id,from:order.status,to:'cancelled',version:next.rows[0].version})]);
    await client.query('COMMIT');
    return {orderId:order.id,status:'cancelled',version:BigInt(next.rows[0].version),replayed:false};
  }catch(err){await client.query('ROLLBACK');throw err;}
  finally{client.release();}
}
