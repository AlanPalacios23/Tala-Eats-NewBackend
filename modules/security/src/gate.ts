/** M9 independent PostgreSQL rate-limits, one-use anti-replay and audit.
 * No raw IP, email, browser identifier, passwords or access tokens persisted.
 */
import {createHmac} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {ACTIONS,SecurityError,validUuid,verifyHostGrant,
 type KeyRing,type SecurityAction} from './grants.js';
export type SecurityConfig={pool:Pool,keyring:KeyRing,pseudonymKey:Buffer};
type Decision={allowed:boolean,code:'M9_ALLOW'|'M9_GRANT_SCOPE_MISMATCH'|
 'M9_STEP_UP_REQUIRED'|'M9_GRANT_REPLAYED'|'M9_RATE_LIMITED'|
 'M9_GRANT_REVOKED',
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
// All operations for the same pseudonymous subject are serialized inside M9.
// Revocation and authorization acquire this advisory lock in the same order.
async function subjectLock(c:PoolClient,subjectHash:string){
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',
  [subjectHash]);
}
async function audit(c:PoolClient,hash:string,action:string,decision:string){
 await c.query('INSERT INTO tala_security_v2.audit_events '+
  '(subject_hash,action,decision) VALUES($1,$2,$3)',[hash,action,decision]);
 const kind=decision==='deny_replay'?'replay_burst':
  decision==='deny_scope'?'scope_probing':
  decision==='deny_rate'?'rate_pressure':null;
 if(!kind)return;
 const bucket=await c.query<{window_start:string}>(
  'SELECT floor(extract(epoch FROM clock_timestamp())/300)::bigint*300 '+
  'AS window_start');
 const start=Number(bucket.rows[0]!.window_start);
 const count=await c.query<{count:number}>(
  'SELECT count(*)::int AS count FROM tala_security_v2.audit_events '+
  'WHERE subject_hash=$1 AND action=$2 AND decision=$3 '+
  'AND at>=to_timestamp($4::bigint) AND at<to_timestamp($4::bigint+300)',
  [hash,action,decision,start]);
 const n=count.rows[0]!.count;
 if(n>=3)await c.query(
  'INSERT INTO tala_security_v2.abuse_alerts '+
  '(subject_hash,action,kind,window_start,observed_denials) '+
  'VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
  [hash,action,kind,start,n]);
}
/** Host-only security operations, never callable from an untrusted body.
 * Host must validate its own session and issuer authority independently.
 */
export async function revokeSecuritySubject(config:SecurityConfig,
 trusted:{canRevokeSecurity?:boolean},subjectId:string){
 if(trusted?.canRevokeSecurity!==true)
  throw new SecurityError('M9_FORBIDDEN');
 const hash=pseudonym(config.pseudonymKey,'subject',validUuid(subjectId));
 return tx(config.pool,async c=>{
  await subjectLock(c,hash);
  const r=await c.query<{revoked_before:string}>(
   'INSERT INTO tala_security_v2.subject_revocations '+
   '(subject_hash,revoked_before) '+
   'VALUES($1,floor(extract(epoch FROM clock_timestamp()))::bigint) '+
   'ON CONFLICT(subject_hash) DO UPDATE SET '+
   'revoked_before=GREATEST(tala_security_v2.subject_revocations.revoked_before,'+
   'EXCLUDED.revoked_before),changed_at=clock_timestamp() '+
   'RETURNING revoked_before::text',[hash]);
  await audit(c,hash,'security.revoke_subject','allow');
  return Object.freeze({revoked:true as const,
   revokedBefore:Number(r.rows[0]!.revoked_before)});
 });
}
/** Revoke one signed grant even if it has not been used yet. */
export async function revokeSecurityGrant(config:SecurityConfig,
 trusted:{canRevokeSecurity?:boolean},signedGrant:string){
 if(trusted?.canRevokeSecurity!==true)
  throw new SecurityError('M9_FORBIDDEN');
 const grant=verifyHostGrant(signedGrant,config.keyring);
 const hash=pseudonym(config.pseudonymKey,'subject',grant.subjectId);
 return tx(config.pool,async c=>{
  await subjectLock(c,hash);
  const r=await c.query(
   'INSERT INTO tala_security_v2.grant_revocations '+
   '(grant_id,subject_hash,expires_at) '+
   'VALUES($1::uuid,$2,to_timestamp($3)) '+
   'ON CONFLICT(grant_id) DO UPDATE SET '+
   'expires_at=GREATEST(tala_security_v2.grant_revocations.expires_at,'+
   'EXCLUDED.expires_at) '+
   'WHERE tala_security_v2.grant_revocations.subject_hash=EXCLUDED.subject_hash '+
   'RETURNING grant_id',[grant.grantId,hash,grant.expiresAt]);
  if(r.rowCount!==1)throw new SecurityError('M9_GRANT_CONFLICT');
  await audit(c,hash,'security.revoke_grant','allow');
  return Object.freeze({revoked:true as const});
 });
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
  await subjectLock(c,subjectHash);
  const denied=async(decision:'deny_scope'|'deny_assurance'|'deny_replay'|'deny_rate'|'deny_revoked',
   code:Decision['code'],retryAfterSeconds?:number):Promise<Decision>=>{
   await audit(c,subjectHash,action,decision);
   return Object.freeze({allowed:false,code,
    ...(retryAfterSeconds===undefined?{}:{retryAfterSeconds})});
  };
  const now=Math.floor(Date.now()/1000);
  if(grant.expiresAt<=now)throw new SecurityError('M9_GRANT_EXPIRED');
  const revoked=await c.query<{revoked:boolean}>(
   'SELECT EXISTS('+
   'SELECT 1 FROM tala_security_v2.subject_revocations '+
   'WHERE subject_hash=$1 AND revoked_before>=$2::bigint'+
   ') OR EXISTS('+
   'SELECT 1 FROM tala_security_v2.grant_revocations '+
   'WHERE grant_id=$3::uuid AND subject_hash=$1'+
   ') AS revoked',[subjectHash,grant.issuedAt,grant.grantId]);
  if(revoked.rows[0]!.revoked)
   return denied('deny_revoked','M9_GRANT_REVOKED');
  if(grant.action!==action||grant.resourceId!==resource)
   return denied('deny_scope','M9_GRANT_SCOPE_MISMATCH');
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
  const alerts=await c.query<{kind:string,action:string,count:number}>(
   'SELECT kind,action,count(*)::int AS count '+
   'FROM tala_security_v2.abuse_alerts '+
   "WHERE created_at>=clock_timestamp()-interval '24 hours' "+
   'GROUP BY kind,action ORDER BY kind,action LIMIT 100');
  return Object.freeze({model:'m9_security_lab_metrics_v2' as const,
   aggregateOnly:true as const,actions:Object.freeze(r.rows.map(x=>Object.freeze(x))),
   alerts:Object.freeze(alerts.rows.map(x=>Object.freeze(x))),
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
  const revoked=await c.query('DELETE FROM tala_security_v2.grant_revocations '+
   'WHERE expires_at<clock_timestamp()');
  return Object.freeze({expiredGrants:grants.rowCount??0,
   expiredBuckets:buckets.rowCount??0,
   expiredRevocations:revoked.rowCount??0});
 });
}
