import type {Pool,PoolClient} from 'pg';
import {RestaurantError,uuid,type Role} from './domain.js';
export async function tx<T>(pool:Pool,fn:(c:PoolClient)=>Promise<T>,
 readonly=false):Promise<T>{
  const c=await pool.connect();
  try{
    await c.query(readonly?'BEGIN READ ONLY':'BEGIN');
    await c.query("SET LOCAL statement_timeout='12000ms'");
    await c.query("SET LOCAL lock_timeout='3000ms'");
    const db=await c.query<{name:string}>('SELECT current_database() AS name');
    if(!['tala_restaurants_v2_lab','tala_restaurants_v2_test']
      .includes(db.rows[0]?.name??''))
      throw new RestaurantError('M6_LAB_ONLY');
    const value=await fn(c);
    await c.query('COMMIT');
    return value;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
  finally{c.release();}
}
export async function access(c:PoolClient,storeId:string,actorId:string,
  allowed:readonly Role[]=['owner','manager','editor'],lock=false){
  const store=uuid(storeId),actor=uuid(actorId);
  const r=await c.query<{role:Role,status:string,version:number}>(
    'SELECT m.role,s.status,s.version FROM tala_restaurants_v2.stores s '+
    'JOIN tala_restaurants_v2.store_staff m ON m.store_id=s.id '+
    'WHERE s.id=$1::uuid AND m.actor_id=$2::uuid '+
    (lock?'FOR UPDATE OF s':''),[store,actor]);
  if(!r.rows[0]||!allowed.includes(r.rows[0].role))
    throw new RestaurantError('M6_FORBIDDEN');
  return r.rows[0];
}
export async function audit(c:PoolClient,storeId:string,actorId:string,
 action:string,entityId:string){
  await c.query(
    'INSERT INTO tala_restaurants_v2.audit(store_id,actor_id,action,entity_id) '+
    'VALUES($1::uuid,$2::uuid,$3,$4::uuid)',
    [storeId,actorId,action,entityId]
  );
}
export async function claim(c:PoolClient,actorId:string,operationId:string,
  action:string,fingerprint:string){
  const actor=uuid(actorId),op=uuid(operationId);
  const inserted=await c.query(
    'INSERT INTO tala_restaurants_v2.idempotency_receipts '+
    '(actor_id,operation_id,action,fingerprint) '+
    'VALUES($1::uuid,$2::uuid,$3,$4) '+
    'ON CONFLICT(actor_id,operation_id) DO NOTHING RETURNING operation_id',
    [actor,op,action,fingerprint]);
  if(inserted.rowCount===1)return null;
  const old=await c.query<{action:string,fingerprint:string,result_id:string|null}>(
    'SELECT action,fingerprint,result_id FROM tala_restaurants_v2.idempotency_receipts '+
    'WHERE actor_id=$1::uuid AND operation_id=$2::uuid',
    [actor,op]);
  if(!old.rows[0]||old.rows[0].action!==action||
     old.rows[0].fingerprint!==fingerprint||!old.rows[0].result_id)
    throw new RestaurantError('M6_IDEMPOTENCY_CONFLICT');
  return old.rows[0].result_id;
}
export async function complete(c:PoolClient,actorId:string,operationId:string,
 resultId:string){
  const r=await c.query(
    'UPDATE tala_restaurants_v2.idempotency_receipts SET result_id=$3::uuid '+
    'WHERE actor_id=$1::uuid AND operation_id=$2::uuid AND result_id IS NULL',
    [actorId,operationId,resultId]);
  if(r.rowCount!==1)throw new RestaurantError('M6_IDEMPOTENCY_CONFLICT');
}
