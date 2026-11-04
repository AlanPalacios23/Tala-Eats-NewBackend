import type {Pool,PoolClient} from 'pg';
import {LocationError,uuid} from './domain.js';
export async function tx<T>(pool:Pool,fn:(c:PoolClient)=>Promise<T>,readOnly=false):Promise<T>{
 const c=await pool.connect();
 try{
  await c.query(readOnly?'BEGIN READ ONLY':'BEGIN');
  await c.query("SET LOCAL statement_timeout='12000ms'");
  await c.query("SET LOCAL lock_timeout='3000ms'");
  const name=await c.query<{name:string}>('SELECT current_database() AS name');
  if(!['tala_locations_v2_lab','tala_locations_v2_test']
    .includes(name.rows[0]?.name??''))
   throw new LocationError('M7_LAB_ONLY');
  const out=await fn(c);
  await c.query('COMMIT');return out;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}
export async function ownerLock(c:PoolClient,owner:string){
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
  ['m7|places|'+uuid(owner)]);
}
export async function audit(c:PoolClient,actor:string,action:string,id:string){
 await c.query('INSERT INTO tala_locations_v2.audit(actor_id,action,entity_id) '+
  'VALUES($1::uuid,$2,$3::uuid)',[actor,action,id]);
}
export async function claim(c:PoolClient,actorId:string,operationId:string,
 action:string,fingerprint:string){
 const added=await c.query('INSERT INTO tala_locations_v2.idempotency_receipts '+
  '(actor_id,operation_id,action,fingerprint) VALUES($1::uuid,$2::uuid,$3,$4) '+
  'ON CONFLICT(actor_id,operation_id) DO NOTHING RETURNING operation_id',
  [actorId,operationId,action,fingerprint]);
 if(added.rowCount===1)return null;
 const old=await c.query<{action:string,fingerprint:string,result_id:string|null}>(
  'SELECT action,fingerprint,result_id FROM tala_locations_v2.idempotency_receipts '+
  'WHERE actor_id=$1::uuid AND operation_id=$2::uuid',[actorId,operationId]);
 if(!old.rows[0]||old.rows[0].action!==action||old.rows[0].fingerprint!==fingerprint||
    !old.rows[0].result_id)throw new LocationError('M7_IDEMPOTENCY_CONFLICT');
 return old.rows[0].result_id;
}
export async function complete(c:PoolClient,actor:string,op:string,id:string){
 const done=await c.query('UPDATE tala_locations_v2.idempotency_receipts '+
  'SET result_id=$3::uuid WHERE actor_id=$1::uuid AND operation_id=$2::uuid '+
  'AND result_id IS NULL',[actor,op,id]);
 if(done.rowCount!==1)throw new LocationError('M7_IDEMPOTENCY_CONFLICT');
}
