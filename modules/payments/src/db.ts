import type {Pool,PoolClient} from 'pg';
import {PaymentError,uuid} from './domain.js';

export async function tx<T>(pool:Pool,run:(c:PoolClient)=>Promise<T>,readOnly=false){
 const c=await pool.connect();
 try{
  await c.query(readOnly?'BEGIN READ ONLY':'BEGIN');
  await c.query("SET LOCAL statement_timeout='12000ms'");
  await c.query("SET LOCAL lock_timeout='3000ms'");
  const r=await c.query<{database:string}>(
   'SELECT current_database() AS database');
  if(!['tala_payments_v2_test','tala_payments_v2_lab']
    .includes(r.rows[0]?.database??''))
   throw new PaymentError('M8_LAB_ONLY');
  const result=await run(c);
  await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}
export async function claim(c:PoolClient,actor:string,op:string,
 action:string,fingerprint:string){
 const r=await c.query(
  'INSERT INTO tala_payments_v2.idempotency_receipts '+
  '(actor_id,operation_id,action,fingerprint) VALUES($1::uuid,$2::uuid,$3,$4) '+
  'ON CONFLICT(actor_id,operation_id) DO NOTHING RETURNING operation_id',
  [actor,op,action,fingerprint]);
 if(r.rowCount===1)return null;
 const previous=await c.query<{action:string,fingerprint:string,result_id:string|null}>(
  'SELECT action,fingerprint,result_id FROM tala_payments_v2.idempotency_receipts '+
  'WHERE actor_id=$1::uuid AND operation_id=$2::uuid',
  [actor,op]);
 if(previous.rows[0]?.action!==action||
  previous.rows[0]?.fingerprint!==fingerprint||
  !previous.rows[0]?.result_id)throw new PaymentError('M8_IDEMPOTENCY_CONFLICT');
 return previous.rows[0].result_id;
}
export async function complete(c:PoolClient,actor:string,op:string,id:string){
 const r=await c.query(
  'UPDATE tala_payments_v2.idempotency_receipts SET result_id=$3::uuid '+
  'WHERE actor_id=$1::uuid AND operation_id=$2::uuid '+
  'AND result_id IS NULL',[actor,op,id]);
 if(r.rowCount!==1)throw new PaymentError('M8_IDEMPOTENCY_CONFLICT');
}
export async function audit(c:PoolClient,actor:string,action:string,entity:string){
 await c.query('INSERT INTO tala_payments_v2.audit(actor_id,action,entity_id) '+
  'VALUES($1::uuid,$2,$3::uuid)',[uuid(actor),action,uuid(entity)]);
}
