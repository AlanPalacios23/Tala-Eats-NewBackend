/** M4 LAB8: durable per-IP/route minute throttling across app instances.
 * Uses HMAC of network identity; no raw IP persisted. This is not a WAF or
 * global bot solution. ONLY a trusted ingress can supply remote IP.
 */
import {createHmac} from 'node:crypto';
import type {Pool} from 'pg';
import {UsersError} from './domain.js';
export async function consumeLabRequestQuota(pool:Pool,{
  remoteAddress,method,route,secret,limit
}:{remoteAddress:string,method:string,route:string,secret:Buffer,limit:number}){
  if(!Buffer.isBuffer(secret)||secret.length<32||
    !Number.isSafeInteger(limit)||limit<1||limit>1000||
    typeof remoteAddress!=='string'||remoteAddress.length>128||
    typeof method!=='string'||method.length>12||
    typeof route!=='string'||route.length>1024)
    throw new UsersError('USERS_RATE_CONFIG_INVALID');
  const subject=createHmac('sha256',secret)
    .update('tala.users.rate.v1|').update(remoteAddress).update('|')
    .update(method).update('|').update(route).digest('hex');
  const c=await pool.connect();
  let count=0;
  try{
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='5000ms'");
    const db=await c.query<{name:string}>('SELECT current_database() AS name');
    if(!['tala_users_v2_test','tala_users_v2_lab'].includes(db.rows[0]?.name??''))
      throw new UsersError('USERS_LAB_ONLY');
    const r=await c.query<{requests:number}>(`
      INSERT INTO tala_users_v2.request_rate_buckets
        (subject_hash,window_started_at,requests)
      VALUES($1,date_trunc('minute',clock_timestamp()),1)
      ON CONFLICT(subject_hash,window_started_at)
      DO UPDATE SET requests=tala_users_v2.request_rate_buckets.requests+1
      RETURNING requests`,[subject]);
    count=r.rows[0]?.requests??0;
    await c.query('COMMIT');
  }catch(error){
    await c.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{c.release();}
  if(count>limit)throw new UsersError('USERS_RATE_LIMITED');
  return Object.freeze({allowed:true});
}
