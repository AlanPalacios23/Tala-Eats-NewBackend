import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {signHostGrant,type HostGrant,type KeyRing,type SecurityAction,
 SecurityError} from '../src/grants.js';
import {authorizeSecurityAction,readSecurityMetrics,pruneExpiredSecurityState,
 type SecurityConfig} from '../src/gate.js';

const url=process.env.SECURITY_CI_URL??'';
const enabled=/\/tala_security_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
const keyring:KeyRing={gate01:randomBytes(32)};
const rateSecret=randomBytes(32);
function makeGrant(subjectId:string,resourceId:string,action:SecurityAction,
 opts:{mfa?:boolean,at?:number,grantId?:string}={}):string{
 const n=Math.floor(Date.now()/1000);
 const grant:HostGrant={
  version:1,issuer:'tala-trusted-gateway-lab',audience:'m9-security-lab',
  grantId:opts.grantId??id(),subjectId,resourceId,action,
  assurance:opts.mfa?'step_up':'session',
  assuranceAt:opts.mfa?(opts.at??n-10):null,
  issuedAt:n-1,expiresAt:n+110
 };
 return signHostGrant(grant,'gate01',keyring);
}
function conf(pool:pg.Pool):SecurityConfig{
 return {pool,keyring,pseudonymKey:rateSecret};
}
const failed=(p:Promise<unknown>,code:string)=>assert.rejects(p,
 e=>e instanceof SecurityError&&e.code===code);
test('M9 LAB database enforces exact scope, resource and step-up freshness',
 {skip:!enabled,timeout:70000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 try{
  const subject=id(),resource=id();
  const regular=makeGrant(subject,resource,'payments.refund.request');
  const denied=await authorizeSecurityAction(conf(pool),{
   grant:regular,action:'payments.refund.request',resourceId:resource});
  assert.equal(denied.allowed,false);
  assert.equal(denied.code,'M9_STEP_UP_REQUIRED');
  const old=makeGrant(subject,resource,'payments.refund.request',
   {mfa:true,at:Math.floor(Date.now()/1000)-400});
  const stale=await authorizeSecurityAction(conf(pool),{
   grant:old,action:'payments.refund.request',resourceId:resource});
  assert.equal(stale.code,'M9_STEP_UP_REQUIRED');
  const fresh=makeGrant(subject,resource,'payments.refund.request',{mfa:true});
  const wrong=await authorizeSecurityAction(conf(pool),{
   grant:fresh,action:'payments.refund.request',resourceId:id()});
  assert.equal(wrong.code,'M9_GRANT_SCOPE_MISMATCH');
  const another=await authorizeSecurityAction(conf(pool),{
   grant:fresh,action:'finance.payout.request',resourceId:resource});
  assert.equal(another.code,'M9_GRANT_SCOPE_MISMATCH');
  const allow=await authorizeSecurityAction(conf(pool),{
   grant:fresh,action:'payments.refund.request',resourceId:resource});
  assert.deepEqual(allow,{allowed:true,code:'M9_ALLOW'});
  const replay=await authorizeSecurityAction(conf(pool),{
   grant:fresh,action:'payments.refund.request',resourceId:resource});
  assert.equal(replay.code,'M9_GRANT_REPLAYED');
  const events=await pool.query<{decision:string}>( 
   'SELECT decision FROM tala_security_v2.audit_events '+
   "WHERE action='payments.refund.request' ORDER BY id DESC LIMIT 5");
  assert.ok(events.rows.some(x=>x.decision==='deny_replay'));
  const rawEvents=await pool.query<{subject_hash:string}>(
   'SELECT subject_hash FROM tala_security_v2.audit_events '+
   'ORDER BY id DESC LIMIT 1');
  assert.equal(rawEvents.rows[0]?.subject_hash.length,64);
  assert.notEqual(rawEvents.rows[0]?.subject_hash,subject.replaceAll('-',''));
 }finally{await pool.end();}
});
test('M9 LAB signed grant cannot be consumed more than once under 18 concurrent requests',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:24});
 try{
  const resource=id();
  const grant=makeGrant(id(),resource,'orders.cancel');
  const res=await Promise.all(Array.from({length:18},()=>
   authorizeSecurityAction(conf(pool),{grant,action:'orders.cancel',
    resourceId:resource})));
  assert.equal(res.filter(x=>x.allowed).length,1);
  assert.equal(res.filter(x=>x.code==='M9_GRANT_REPLAYED').length,17);
  const metrics=await readSecurityMetrics(pool,{canMonitorSecurity:true});
  assert.equal(metrics.aggregateOnly,true);
  assert.equal(Object.hasOwn(metrics,'subjectId'),false);
  await failed(readSecurityMetrics(pool,{}),'M9_FORBIDDEN');
 }finally{await pool.end();}
});
test('M9 LAB distributed rate limiting blocks 4th approved high-risk operation',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:16});
 try{
  const actor=id(),resource=id(),action='finance.payout.request';
  const decisions=await Promise.all(Array.from({length:4},()=> 
   authorizeSecurityAction(conf(pool),{
    grant:makeGrant(actor,resource,action,{mfa:true}),action,
    resourceId:resource
   })));
  assert.equal(decisions.filter(x=>x.allowed).length,3);
  assert.equal(decisions.filter(x=>x.code==='M9_RATE_LIMITED').length,1);
  assert.ok(decisions.some(x=>x.retryAfterSeconds!==undefined&&
   x.retryAfterSeconds>=1&&x.retryAfterSeconds<=60));
  const counted=await pool.query<{hits:number}>(
   'SELECT hits FROM tala_security_v2.rate_buckets WHERE hits=3 '+
   'ORDER BY window_start DESC LIMIT 1');
  assert.equal(counted.rows[0]?.hits,3);
  assert.ok((await readSecurityMetrics(pool,{canMonitorSecurity:true}))
   .actions.some(x=>x.decision==='deny_rate'));
 }finally{await pool.end();}
});
test('M9 LAB maintenance cleans expired nonces and buckets but retains immutable audit',
 {skip:!enabled,timeout:65000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8});
 try{
  const jti=id(),hash='a'.repeat(64),bucket='b'.repeat(64);
  await pool.query('INSERT INTO tala_security_v2.used_grants '+
   '(grant_id,subject_hash,action,expires_at) '+
   "VALUES($1::uuid,$2,'orders.cancel',clock_timestamp()-interval '1 day')",
   [jti,hash]);
  await pool.query('INSERT INTO tala_security_v2.rate_buckets '+
   '(subject_action_hash,window_start,hits,expires_at) '+
   "VALUES($1,1000,1,clock_timestamp()-interval '1 day')",[bucket]);
  await failed(pruneExpiredSecurityState(pool,{}),'M9_FORBIDDEN');
  const result=await pruneExpiredSecurityState(pool,{canMaintainSecurity:true});
  assert.ok(result.expiredGrants>=1&&result.expiredBuckets>=1);
  const removed=await pool.query('SELECT 1 FROM tala_security_v2.used_grants '+
   'WHERE grant_id=$1::uuid',[jti]);
  assert.equal(removed.rows.length,0);
  await assert.rejects(pool.query('DELETE FROM tala_security_v2.audit_events'),
   /SECURITY_AUDIT_IMMUTABLE/);
 }finally{await pool.end();}
});
