/**
 * CORE v2 - end-of-order fulfillment, ISOLATED LAB ONLY.
 *
 * Cash proof is dual-attested (customer + actual custodian), then a one-time
 * customer PIN verifies handoff. "paid" is cash collected, NOT bank/merchant
 * settlement. custody_settled_at stays NULL for future ledger reconciliation.
 * No Stripe, no payouts, no background dispatch.
 */
import {createHash,randomBytes,randomInt,scrypt as scryptCb,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import type {Pool,PoolClient} from 'pg';
import {OrderServiceError} from './checkout.ts';
import {transitionOrder,OrderTransitionError} from './order-machine.ts';
import type {OrderStatus,Fulfillment,PaymentMethod} from './order-machine.ts';

const scrypt=promisify(scryptCb);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const keyPattern=/^[a-zA-Z0-9_.:-]{16,128}$/;
type Role='customer'|'merchant'|'driver';
type Row={id:string;buyer_id:string;restaurant_id:string;fulfillment:Fulfillment;
  status:OrderStatus;payment_method:PaymentMethod;payment_status:string;
  total_minor:string;version:string};
type Handoff={pin_salt:string|null;pin_hash:string|null;pin_expires_at:Date|null;
  pin_failures:number;pin_consumed_at:Date|null;buyer_cash_ack_at:Date|null;
  custodian_cash_ack_at:Date|null;custodian_id:string|null;custodian_role:string|null;
  cash_amount_minor:string};
type Command={orderId:string;actorId:string;commandKey:string;expectedVersion:bigint};
type Result={orderId:string;status:OrderStatus;version:bigint;replayed:boolean};
const codeKey=(kind:string,cmd:Command)=>createHash('sha256')
  .update([kind,cmd.orderId,cmd.actorId,cmd.commandKey].join('|')).digest('hex');
function validateCommand(cmd:Command):void{
  if(!uuid.test(cmd.orderId)||!uuid.test(cmd.actorId)||
    !keyPattern.test(cmd.commandKey)||typeof cmd.expectedVersion!=='bigint'||
    cmd.expectedVersion<1n)throw new OrderServiceError('COMMAND_INVALID');
}
async function begin(client:PoolClient){
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='3000ms'");
  await client.query("SET LOCAL statement_timeout='10000ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
}
async function lockedOrder(client:PoolClient,orderId:string):Promise<Row>{
  const r=await client.query<Row>(
    'SELECT id,buyer_id,restaurant_id,fulfillment,status,payment_method,payment_status,total_minor,version FROM tala_core_v2.orders WHERE id=$1::uuid FOR UPDATE',
    [orderId]);
  if(!r.rows[0])throw new OrderServiceError('ORDER_NOT_FOUND');
  return r.rows[0];
}
async function authorized(client:PoolClient,order:Row,id:string,role:Role){
  if(role==='customer'){
    if(order.buyer_id!==id)throw new OrderServiceError('ORDER_NOT_FOUND');
  }else if(role==='merchant'){
    const m=await client.query(`
      SELECT 1 FROM tala_core_v2.restaurant_memberships
      WHERE restaurant_id=$1::uuid AND member_id=$2::uuid AND is_active=true FOR SHARE`,
      [order.restaurant_id,id]);
    if(!m.rowCount)throw new OrderServiceError('ORDER_NOT_FOUND');
  }else{
    const m=await client.query(`
      SELECT 1 FROM tala_core_v2.order_driver_assignments d
      JOIN tala_core_v2.driver_profiles p ON p.account_id=d.driver_id
      JOIN tala_core_v2.accounts a ON a.id=d.driver_id
      WHERE d.order_id=$1::uuid AND d.driver_id=$2::uuid
        AND p.approved=true AND a.is_active=true AND a.role='driver'`,
      [order.id,id]);
    if(!m.rowCount)throw new OrderServiceError('ORDER_NOT_FOUND');
  }
}
async function event(client:PoolClient,order:Row,eventKey:string,kind:string,
  from:OrderStatus,to:OrderStatus,role:Role,id:string,data:Record<string,unknown>){
  await client.query(`
    INSERT INTO tala_core_v2.order_events
      (order_id,event_key,previous_status,new_status,actor_role,actor_id,data)
    VALUES($1::uuid,$2,$3,$4,$5,$6::uuid,$7::jsonb)`,
    [order.id,eventKey,from,to,role,id,JSON.stringify(data)]);
  await client.query(`
    INSERT INTO tala_core_v2.outbox(aggregate_id,event_key,event_type,payload)
    VALUES($1::uuid,$2,$3,$4::jsonb)`,
    [order.id,eventKey,kind,JSON.stringify({
      orderId:order.id,from,to,version:data.version??order.version
    })]);
}
async function checkReplay(client:PoolClient,order:Row,k:string,
  cmd:Command,target:OrderStatus):Promise<boolean>{
  const r=await client.query<{actor_id:string;new_status:OrderStatus;
    data:{expectedVersion?:string}}>(`
    SELECT actor_id,new_status,data FROM tala_core_v2.order_events
    WHERE order_id=$1::uuid AND event_key=$2`,[order.id,k]);
  if(!r.rows[0])return false;
  if(r.rows[0].actor_id!==cmd.actorId||r.rows[0].new_status!==target||
     r.rows[0].data?.expectedVersion!==String(cmd.expectedVersion))
    throw new OrderServiceError('IDEMPOTENCY_CONFLICT');
  return true;
}
function checkVersion(order:Row,cmd:Command){
  if(BigInt(order.version)!==cmd.expectedVersion)
    throw new OrderServiceError('ORDER_VERSION_CONFLICT');
}
function transit(order:Row,to:OrderStatus,role:'system'|'driver'|'merchant',
  proof:{paymentVerified?:boolean;pickupProofVerified?:boolean;deliveryPinVerified?:boolean}={}){
  try{transitionOrder({
    current:order.status,target:to,fulfillment:order.fulfillment,
    paymentMethod:order.payment_method,actor:role,...proof
  });}catch(error){
    if(error instanceof OrderTransitionError)
      throw new OrderServiceError(error.code);
    throw error;
  }
}
async function ensureHandoff(client:PoolClient,order:Row):Promise<Handoff>{
  await client.query(`
    INSERT INTO tala_core_v2.order_handoffs(order_id,cash_amount_minor)
    VALUES($1::uuid,$2::bigint) ON CONFLICT(order_id) DO NOTHING`,
    [order.id,order.total_minor]);
  const r=await client.query<Handoff>(`
    SELECT pin_salt,pin_hash,pin_expires_at,pin_failures,pin_consumed_at,
      buyer_cash_ack_at,custodian_cash_ack_at,custodian_id,custodian_role,
      cash_amount_minor
    FROM tala_core_v2.order_handoffs WHERE order_id=$1::uuid FOR UPDATE`,[order.id]);
  if(!r.rows[0]||r.rows[0].cash_amount_minor!==order.total_minor)
    throw new OrderServiceError('CASH_SNAPSHOT_MISMATCH');
  return r.rows[0];
}
const handoffState=(order:Row)=>
  (order.fulfillment==='pickup'&&order.status==='ready')||
  (order.fulfillment==='delivery'&&order.status==='on_the_way');

export async function availableDriverOrders(pool:Pool,driverId:string){
  const r=await pool.query(`
    SELECT o.id,r.name AS restaurant_name,o.total_minor,o.created_at
    FROM tala_core_v2.orders o
    JOIN tala_core_v2.restaurants r ON r.id=o.restaurant_id
    WHERE o.status='ready' AND o.fulfillment='delivery'
      AND o.payment_method='cash' AND o.payment_status='pending'
      AND NOT EXISTS(SELECT 1 FROM tala_core_v2.order_driver_assignments d WHERE d.order_id=o.id)
      AND EXISTS(SELECT 1 FROM tala_core_v2.driver_profiles p
        JOIN tala_core_v2.accounts a ON a.id=p.account_id
        WHERE p.account_id=$1::uuid AND p.approved=true AND p.is_online=true
          AND a.is_active=true AND a.role='driver')
    ORDER BY o.created_at,o.id LIMIT 50`,[driverId]);
  return r.rows;
}
export async function myDriverOrders(pool:Pool,driverId:string){
  const r=await pool.query(`
    SELECT o.id,o.status,o.version,o.total_minor,o.delivery_address,
      o.restaurant_id,o.payment_status,o.created_at
    FROM tala_core_v2.orders o
    JOIN tala_core_v2.order_driver_assignments d ON d.order_id=o.id
    JOIN tala_core_v2.driver_profiles p ON p.account_id=d.driver_id
    WHERE d.driver_id=$1::uuid AND p.approved=true
    ORDER BY o.created_at DESC LIMIT 100`,[driverId]);
  return r.rows;
}
export async function claimDelivery(pool:Pool,cmd:Command):Promise<Result>{
  validateCommand(cmd);
  const client=await pool.connect();
  try{
    await begin(client);
    const order=await lockedOrder(client,cmd.orderId);
    const p=await client.query(`
      SELECT 1 FROM tala_core_v2.driver_profiles p
      JOIN tala_core_v2.accounts a ON a.id=p.account_id
      WHERE p.account_id=$1::uuid AND p.approved=true AND p.is_online=true
        AND a.is_active=true AND a.role='driver' FOR SHARE OF p,a`,[cmd.actorId]);
    if(!p.rowCount)throw new OrderServiceError('DRIVER_NOT_AVAILABLE');
    const k=codeKey('driver.claim.v1',cmd);
    if(await checkReplay(client,order,k,cmd,'assigned')){
      await client.query('COMMIT');
      return {orderId:order.id,status:order.status,version:BigInt(order.version),replayed:true};
    }
    checkVersion(order,cmd);
    if(order.payment_method!=='cash'||order.payment_status!=='pending')
      throw new OrderServiceError('PAYMENT_NOT_ALLOWED');
    transit(order,'assigned','system');
    const claimed=await client.query(`
      SELECT 1 FROM tala_core_v2.order_driver_assignments WHERE order_id=$1::uuid`,[order.id]);
    if(claimed.rowCount)throw new OrderServiceError('ORDER_ALREADY_ASSIGNED');
    await client.query(`
      INSERT INTO tala_core_v2.order_driver_assignments(order_id,driver_id)
      VALUES($1::uuid,$2::uuid)`,[order.id,cmd.actorId]);
    const next=await client.query<{version:string}>(`
      UPDATE tala_core_v2.orders SET status='assigned',version=version+1,updated_at=now()
      WHERE id=$1::uuid RETURNING version`,[order.id]);
    await event(client,order,k,'order.driver.assigned',order.status,'assigned','driver',cmd.actorId,{
      expectedVersion:String(cmd.expectedVersion),version:next.rows[0]!.version,
      assignment:'self_claim_lab'
    });
    await client.query('COMMIT');
    return {orderId:order.id,status:'assigned',version:BigInt(next.rows[0]!.version),replayed:false};
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}
export async function advanceDelivery(pool:Pool,cmd:Command,
  target:'picked_up'|'on_the_way'):Promise<Result>{
  validateCommand(cmd);
  const client=await pool.connect();
  try{
    await begin(client);
    const order=await lockedOrder(client,cmd.orderId);
    await authorized(client,order,cmd.actorId,'driver');
    const k=codeKey('driver.advance.'+target,cmd);
    if(await checkReplay(client,order,k,cmd,target)){
      await client.query('COMMIT');
      return {orderId:order.id,status:order.status,version:BigInt(order.version),replayed:true};
    }
    checkVersion(order,cmd);
    transit(order,target,'driver');
    const next=await client.query<{version:string}>(`
      UPDATE tala_core_v2.orders SET status=$2,version=version+1,updated_at=now()
      WHERE id=$1::uuid RETURNING version`,[order.id,target]);
    await event(client,order,k,'order.status.changed',order.status,target,'driver',cmd.actorId,{
      expectedVersion:String(cmd.expectedVersion),version:next.rows[0]!.version
    });
    await client.query('COMMIT');
    return {orderId:order.id,status:target,version:BigInt(next.rows[0]!.version),replayed:false};
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}
export async function issueBuyerHandoffPin(pool:Pool,buyerId:string,orderId:string):
  Promise<{orderId:string;pin:string;expiresInSeconds:number}>{
  if(!uuid.test(buyerId)||!uuid.test(orderId))throw new OrderServiceError('COMMAND_INVALID');
  const client=await pool.connect();
  try{
    await begin(client);
    const order=await lockedOrder(client,orderId);
    await authorized(client,order,buyerId,'customer');
    if(!handoffState(order)||order.payment_method!=='cash'||
      order.payment_status!=='pending')
      throw new OrderServiceError('HANDOFF_NOT_READY');
    await ensureHandoff(client,order);
    const pin=String(randomInt(10000000,100000000));
    const salt=randomBytes(16).toString('hex');
    const digest=(await scrypt(pin,salt,64) as Buffer).toString('hex');
    await client.query(`
      UPDATE tala_core_v2.order_handoffs
      SET pin_hash=$2,pin_salt=$3,pin_expires_at=now()+interval '10 minutes',
        pin_failures=0,pin_consumed_at=NULL
      WHERE order_id=$1::uuid`,[order.id,digest,salt]);
    // Audit PIN issuance/rotation without ever storing or publishing the PIN.
    const auditKey=createHash('sha256').update(
      'pin.issued.v1|'+order.id+'|'+randomBytes(16).toString('hex')).digest('hex');
    await event(client,order,auditKey,'order.pin.issued',
      order.status,order.status,'customer',buyerId,{
        expiresInSeconds:600,failedAttemptsReset:true
      });
    await client.query('COMMIT');
    // PIN is only ever returned to authenticated buyer, never persisted plain.
    return {orderId:order.id,pin,expiresInSeconds:600};
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}
export async function attestCash(pool:Pool,orderId:string,id:string,role:Role):
  Promise<{orderId:string;role:Role;replayed:boolean;cashAmountMinor:string}>{
  if(!uuid.test(orderId)||!uuid.test(id)||!['customer','merchant','driver'].includes(role))
    throw new OrderServiceError('COMMAND_INVALID');
  const client=await pool.connect();
  try{
    await begin(client);
    const order=await lockedOrder(client,orderId);
    await authorized(client,order,id,role);
    if(!handoffState(order)||order.payment_method!=='cash'||order.payment_status!=='pending')
      throw new OrderServiceError('CASH_HANDOFF_NOT_READY');
    if(role!=='customer'&&
      (order.fulfillment==='pickup'?'merchant':'driver')!==role)
      throw new OrderServiceError('CUSTODIAN_ROLE_FORBIDDEN');
    const handoff=await ensureHandoff(client,order);
    const isBuyer=role==='customer';
    const already=isBuyer?!!handoff.buyer_cash_ack_at:!!handoff.custodian_cash_ack_at;
    if(already){
      if(!isBuyer&&handoff.custodian_id!==id)
        throw new OrderServiceError('CUSTODIAN_ALREADY_RECORDED');
      await client.query('COMMIT');
      return {orderId,role,replayed:true,cashAmountMinor:order.total_minor};
    }
    if(isBuyer){
      await client.query(`
        UPDATE tala_core_v2.order_handoffs SET buyer_cash_ack_at=now()
        WHERE order_id=$1::uuid`,[orderId]);
    }else{
      await client.query(`
        UPDATE tala_core_v2.order_handoffs
        SET custodian_cash_ack_at=now(),custodian_id=$2::uuid,custodian_role=$3
        WHERE order_id=$1::uuid`,[orderId,id,role]);
    }
    const k=createHash('sha256').update(['cash.ack.v1',order.id,role,id].join('|')).digest('hex');
    await event(client,order,k,'order.cash.attested',order.status,order.status,role,id,{
      side:isBuyer?'buyer':'custodian',cashAmountMinor:order.total_minor,
      custodySettled:false
    });
    await client.query('COMMIT');
    return {orderId,role,replayed:false,cashAmountMinor:order.total_minor};
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}
export async function finishCashOrder(pool:Pool,cmd:Command,role:'merchant'|'driver',pin:string):
  Promise<Result>{
  validateCommand(cmd);
  if(!/^\d{8}$/.test(pin))throw new OrderServiceError('PIN_INVALID');
  const client=await pool.connect();
  let committed=false;
  try{
    await begin(client);
    const order=await lockedOrder(client,cmd.orderId);
    await authorized(client,order,cmd.actorId,role);
    const k=codeKey('order.finalize.'+role,cmd);
    if(await checkReplay(client,order,k,cmd,'delivered')){
      // Idempotent replay must match the original PIN proof. Never accept a
      // different PIN with the same commandKey even after completion.
      const original=await client.query<{pin_salt:string|null;pin_hash:string|null}>(`
        SELECT pin_salt,pin_hash FROM tala_core_v2.order_handoffs
        WHERE order_id=$1::uuid`,[order.id]);
      const proof=original.rows[0];
      if(!proof?.pin_salt||!proof.pin_hash)
        throw new OrderServiceError('IDEMPOTENCY_CONFLICT');
      const digest=await scrypt(pin,proof.pin_salt,64) as Buffer;
      if(!timingSafeEqual(digest,Buffer.from(proof.pin_hash,'hex')))
        throw new OrderServiceError('IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT');committed=true;
      return {orderId:order.id,status:order.status,version:BigInt(order.version),replayed:true};
    }
    checkVersion(order,cmd);
    if(!handoffState(order)||order.payment_method!=='cash'||order.payment_status!=='pending')
      throw new OrderServiceError('HANDOFF_NOT_READY');
    if((order.fulfillment==='pickup'?'merchant':'driver')!==role)
      throw new OrderServiceError('CUSTODIAN_ROLE_FORBIDDEN');
    const h=await ensureHandoff(client,order);
    if(!h.buyer_cash_ack_at||!h.custodian_cash_ack_at||
      h.custodian_id!==cmd.actorId||h.custodian_role!==role)
      throw new OrderServiceError('CASH_DUAL_ACK_REQUIRED');
    if(!h.pin_hash||!h.pin_salt||!h.pin_expires_at||h.pin_consumed_at||
      new Date(h.pin_expires_at).getTime()<=Date.now())
      throw new OrderServiceError('PIN_MISSING_OR_EXPIRED');
    if(h.pin_failures>=5)throw new OrderServiceError('PIN_ATTEMPTS_EXCEEDED');
    const calculated=await scrypt(pin,h.pin_salt,64) as Buffer;
    const valid=timingSafeEqual(calculated,Buffer.from(h.pin_hash,'hex'));
    if(!valid){
      await client.query(`
        UPDATE tala_core_v2.order_handoffs SET pin_failures=pin_failures+1
        WHERE order_id=$1::uuid`,[order.id]);
      await client.query('COMMIT');committed=true;
      throw new OrderServiceError('PIN_INVALID');
    }
    // Cash is collected from buyer with TWO logged attestations; funds remain
    // in the named custodian's possession and NOT settled to merchant/wallet.
    transit(order,'delivered',role,{
      paymentVerified:true,pickupProofVerified:true,deliveryPinVerified:true
    });
    const next=await client.query<{version:string}>(`
      UPDATE tala_core_v2.orders
      SET status='delivered',payment_status='paid',version=version+1,updated_at=now()
      WHERE id=$1::uuid RETURNING version`,[order.id]);
    await client.query(`
      UPDATE tala_core_v2.order_handoffs SET pin_consumed_at=now()
      WHERE order_id=$1::uuid`,[order.id]);
    await event(client,order,k,'order.delivered',order.status,'delivered',role,cmd.actorId,{
      expectedVersion:String(cmd.expectedVersion),version:next.rows[0]!.version,
      cashAmountMinor:order.total_minor,custodySettled:false,
      pinVerified:true,buyerAttested:true,custodianAttested:true
    });
    await client.query('COMMIT');committed=true;
    return {orderId:order.id,status:'delivered',version:BigInt(next.rows[0]!.version),replayed:false};
  }catch(error){if(!committed)await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}
