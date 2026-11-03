/** Isolated M5 PostgreSQL transaction; no shared schema or production access. */
import type {Pool,PoolClient} from 'pg';
import {NotificationError} from './domain.js';
export async function transaction<T>(pool:Pool,
  fn:(c:PoolClient)=>Promise<T>,readOnly=false):Promise<T>{
  const c=await pool.connect();
  try{
    await c.query(readOnly?'BEGIN READ ONLY':'BEGIN');
    await c.query("SET LOCAL statement_timeout='10000ms'");
    await c.query("SET LOCAL lock_timeout='3000ms'");
    const db=await c.query<{name:string}>('SELECT current_database() AS name');
    if(!['tala_notifications_v2_test','tala_notifications_v2_lab']
      .includes(db.rows[0]?.name??''))
      throw new NotificationError('NOTIFICATIONS_LAB_ONLY');
    const value=await fn(c);
    await c.query('COMMIT');
    return value;
  }catch(error){
    await c.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{c.release();}
}
