/** M9 independent PostgreSQL rate-limits, one-use anti-replay and audit.
 * No raw IP, email, browser identifier, passwords or access tokens persisted.
 */
import {createHmac} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {ACTIONS,SecurityError,validUuid,verifyHostGrant,
 type KeyRing,type SecurityAction} from './grants.js';
export type SecurityConfig={pool:Pool,keyring:KeyRing,pseudonymKey:Buffer};
type Decision={allowed:boolean,code:'M9_ALLOW'|'M9_GRANT_SCOPE_MISMATCH'|
 'M9_STEP_UP_REQUIRED'|'M9_GRANT_REPLAYED'|'M9_RATE_LIMITED',
 retryAfterSeconds?:number};
const DB=['tala_security_v2_test','tala_security_v2_lab'];
async function tx<T>(pool:Pool,run:(c:PoolClient)=>Promise<T>,readonly=false):Promise<T>{
 const c=await pool.connect();
 try{
  await c.query(readonly?'BEGIN READ ONLY':'BEGIN');
  await c.query("SET LOCAL statement_timeout='12000ms'");
  await c.query("SET LOCAL lock_timeout='3000ms'");
  const database=await c.query<{database:string}>('SELECT current_database() AS database');
  if(!DB.includes(database.rows[0]?.database??''))
   throw new SecurityError('M9_LAB_ONLY');
  const result=await run(c);
  await c.query('COMMIT');return result;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
 finally{c.release();}
}
function pseudonym(secret:Buffer,tag:string,value:string){
 if(!Buffer.isBuffer(secret)||secret.length<32)
  throw new SecurityError('M9_PSEUDONYM_KEY_INVALID');
 return createHmac('sha256',secret).update(tag+'|'+value).digest('hex');
}
async function audit(c:PoolClient,hash:string,action:string,decision:string){
 await c.query('INSERT INTO tala_security_v2.audit_events '+
  '(subject_hash,action,decision) VALUES($1,$2,$3)',[hash,action,decision]);
}
export async function authorizeSecurityAction(config:SecurityConfig,input:{
 grant:string,action:string,resourceId:string
}):Promise<Decision>{
 if(!config||typeof input.action!=='string'||
    !Object.hasOwn(ACTIONS,input.action))
  throw new SecurityError('M9_ACTION_INVALID');
 const action=input.action as SecurityAction;
 const resource=validUuid(input.resourceId);
 const grant=verifyHostGrant(input.grant,config.keyring);
 const subjectHash=pseudonym(config.pseudonymKey,'subject',grant.subjectId);
 const key=pseudonym(config.pseudonymKey,'bucket',grant.subjectId+':'+action);
 const rules=ACTIONS[action];
 return tx(config.pool,async c=>{
  const denied=async(decision:'deny_scope'|'deny_assurance'|'deny_replay'|'deny_rate',
   code:Decision['code'],retryAfterSeconds?:number):Promise<Decision>=>{
   await audit(c,subjectHash,action,decision);
   return Object.freeze({allowed:false,code,
    ...(retryAfterSeconds===undefined?{}:{retryAfterSeconds})});
  };
  if(grant.action!==action||grant.resourceId!==resource)
   return denied('deny_scope','M9_GRANT_SCOPE_MISMATCH');
  const now=Math.floor(Date.now()/1000);
  if(rules.stepUp&&(grant.assurance!=='step_up'||grant.assuranceAt===null||
    grant.assuranceAt>now+30||now-grant.assuranceAt>300))
   return denied('deny_assurance','M9_STEP_UP_REQUIRED');
  const used=await c.query(
   'INSERT INTO tala_security_v2.used_grants '+
   '(grant_id,subject_hash,action,expires_at) '+
   'VALUES($1::uuid,$2,$3,to_timestamp($4)) '+
   'ON CONFLICT(grant_id) DO NOTHING RETURNING grant_id',
   [grant.grantId,subjectHash,action,grant.expiresAt]);
  if(used.rowCount!==1)
   return denied('deny_replay','M9_GRANT_REPLAYED');
  const bucketTime=await c.query<{start:string}>(
   'SELECT (floor(extract(epoch FROM clock_timestamp())/60)::bigint*60) '+
   'AS start');
  const start=Number(bucketTime.rows[0]!.start);
  const hit=await c.query<{hits:number}>(
   'INSERT INTO tala_security_v2.rate_buckets '+
   '(subject_action_hash,window_start,hits,expires_at) '+
   'VALUES($1,$2,1,to_timestamp($2::bigint+120)) '+
   'ON CONFLICT(subject_action_hash,window_start) DO UPDATE '+
   'SET hits=tala_security_v2.rate_buckets.hits+1 '+
   'WHERE tala_security_v2.rate_buckets.hits<$3 RETURNING hits',
   [key,start,rules.limit]);
  if(hit.rowCount!==1){
   // A throttled token has not been authorized: allow it to be retried
   // after the window changes, provided it is still unexpired.
   await c.query('DELETE FROM tala_security_v2.used_grants '+
    'WHERE grant_id=$1::uuid',[grant.grantId]);
   return denied('deny_rate','M9_RATE_LIMITED',
    Math.max(1,start+60-Math.floor(Date.now()/1000)));
  }
  await audit(c,subjectHash,action,'allow');
  return Object.freeze({allowed:true,code:'M9_ALLOW' as const});
 });
}
export async function readSecurityMetrics(pool:Pool,hostAccess:{canMonitorSecurity?:boolean}){
 if(hostAccess?.canMonitorSecurity!==true)
  throw new SecurityError('M9_FORBIDDEN');
 return tx(pool,async c=>{
  const r=await c.query<{action:string,decision:string,count:number}>(
   'SELECT action,decision,count(*)::int AS count '+
   'FROM tala_security_v2.audit_events '+
   "WHERE at>=clock_timestamp()-interval '24 hours' "+
   'GROUP BY action,decision ORDER BY action,decision LIMIT 100');
  const queued=await c.query<{grants:number,buckets:number}>(
   'SELECT (SELECT count(*)::int FROM tala_security_v2.used_grants) AS grants,'+
   '(SELECT count(*)::int FROM tala_security_v2.rate_buckets) AS buckets');
  return Object.freeze({model:'m9_security_lab_metrics_v1' as const,
   aggregateOnly:true as const,actions:Object.freeze(r.rows.map(x=>Object.freeze(x))),
   maintenance:Object.freeze(queued.rows[0]!)});
 },true);
}
/** Schedule externally. Retention of pseudonymous audits needs an approved
 * external policy; M9 deliberately does not silently delete immutable audit.
 */
export async function pruneExpiredSecurityState(pool:Pool,hostAccess:{
 canMaintainSecurity?:boolean}){
 if(hostAccess?.canMaintainSecurity!==true)
  throw new SecurityError('M9_FORBIDDEN');
 return tx(pool,async c=>{
  const grants=await c.query('DELETE FROM tala_security_v2.used_grants '+
   'WHERE expires_at<clock_timestamp()');
  const buckets=await c.query('DELETE FROM tala_security_v2.rate_buckets '+
   'WHERE expires_at<clock_timestamp()');
  return Object.freeze({expiredGrants:grants.rowCount??0,
   expiredBuckets:buckets.rowCount??0});
 });
}
