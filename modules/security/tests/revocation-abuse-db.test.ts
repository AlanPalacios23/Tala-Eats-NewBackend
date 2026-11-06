import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {signHostGrant,type KeyRing,type HostGrant,type SecurityAction,
 SecurityError} from '../src/grants.js';
import {authorizeSecurityAction,revokeSecuritySubject,revokeSecurityGrant,
 readSecurityMetrics,pruneExpiredSecurityState,type SecurityConfig} from '../src/gate.js';

const url=process.env.SECURITY_CI_URL??'';
const enabled=/\/tala_security_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
const keyring:KeyRing={gate01:randomBytes(32),gate02:randomBytes(32)};
const pseudonymKey=randomBytes(32);
const config=(pool:pg.Pool):SecurityConfig=>({pool,keyring,pseudonymKey});
const action='payments.refund.request';
function grant(subjectId:string,resourceId:string,
 operation:SecurityAction=action,assurance:'session'|'step_up'='step_up'){
 const now=Math.floor(Date.now()/1000);
 const claim:HostGrant={version:1,issuer:'tala-trusted-gateway-lab',
  audience:'m9-security-lab',grantId:id(),subjectId,resourceId,
  action:operation,assurance,
  assuranceAt:assurance==='step_up'?now-5:null,
  issuedAt:now-1,expiresAt:now+100};
 return signHostGrant(claim,'gate01',keyring);
}
function denied(p:Promise<unknown>,code:string){
 return assert.rejects(p,
  e=>e instanceof SecurityError&&e.code===code);
}

test('M9 LAB2 one-grant revocation is atomic and never mints a substitute grant',
 {skip:!enabled,timeout:65000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 try{
  const subject=id(),resource=id();
  const g=grant(subject,resource),unrelated=grant(subject,resource);
  await denied(revokeSecurityGrant(config(pool),{},g),'M9_FORBIDDEN');
  const rev=await revokeSecurityGrant(config(pool),
   {canRevokeSecurity:true},g);
  assert.equal(rev.revoked,true);
  const answer=await authorizeSecurityAction(config(pool),
   {grant:g,action,resourceId:resource});
  assert.deepEqual(answer,{allowed:false,code:'M9_GRANT_REVOKED'});
  const other=await authorizeSecurityAction(config(pool),
   {grant:unrelated,action,resourceId:resource});
  assert.equal(other.allowed,true);
  assert.equal((await readSecurityMetrics(pool,{canMonitorSecurity:true}))
   .actions.some(x=>x.decision==='deny_revoked'),true);
  // Repeated revoke is idempotent and preserves expiry.
  assert.equal((await revokeSecurityGrant(config(pool),
   {canRevokeSecurity:true},g)).revoked,true);
 }finally{await pool.end();}
});

test('M9 LAB2 subject revocation invalidates all previous grants but not unrelated subjects',
 {skip:!enabled,timeout:65000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 try{
  const subject=id(),other=id(),resource=id();
  const sameUser=Array.from({length:12},()=>grant(subject,resource));
  const otherGrant=grant(other,resource);
  await denied(revokeSecuritySubject(config(pool),{},subject),'M9_FORBIDDEN');
  const revoked=await revokeSecuritySubject(config(pool),
   {canRevokeSecurity:true},subject);
  assert.equal(revoked.revoked,true);
  assert.ok(revoked.revokedBefore>0);
  const results=await Promise.all(sameUser.map(g=>
   authorizeSecurityAction(config(pool),
    {grant:g,action,resourceId:resource})));
  assert.ok(results.every(x=>x.code==='M9_GRANT_REVOKED'));
  const unaffected=await authorizeSecurityAction(config(pool),
   {grant:otherGrant,action,resourceId:resource});
  assert.equal(unaffected.code,'M9_ALLOW');
  const repeated=await revokeSecuritySubject(config(pool),
   {canRevokeSecurity:true},subject);
  assert.ok(repeated.revokedBefore>=revoked.revokedBefore);
  // A short-lived revocation should not retain a pseudonym forever:
  // at 150+ seconds every affected grant has naturally expired.
  await pool.query('UPDATE tala_security_v2.subject_revocations '+
   "SET revoked_before=floor(extract(epoch FROM clock_timestamp()))::bigint-180 "+
   'WHERE subject_hash=(SELECT subject_hash FROM tala_security_v2.subject_revocations '+
   'ORDER BY changed_at DESC LIMIT 1)');
  const pruned=await pruneExpiredSecurityState(pool,{canMaintainSecurity:true});
  assert.ok(pruned.expiredSubjectRevocations>=1);
 }finally{await pool.end();}
});

test('M9 LAB2 replay and scope probing generate deduplicated local abuse alerts',
 {skip:!enabled,timeout:80000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 try{
  const subject=id(),resource=id();
  const used=grant(subject,resource,'orders.cancel','session');
  const one=await authorizeSecurityAction(config(pool),
   {grant:used,action:'orders.cancel',resourceId:resource});
  assert.equal(one.code,'M9_ALLOW');
  const replays=await Promise.all(Array.from({length:6},()=>
   authorizeSecurityAction(config(pool),
    {grant:used,action:'orders.cancel',resourceId:resource})));
  assert.ok(replays.every(x=>x.code==='M9_GRANT_REPLAYED'));
  const target=grant(subject,resource,'orders.cancel','session');
  const probes=await Promise.all(Array.from({length:4},()=>
   authorizeSecurityAction(config(pool),
    {grant:target,action:'orders.cancel',resourceId:id()})));
  assert.ok(probes.every(x=>x.code==='M9_GRANT_SCOPE_MISMATCH'));
  const alerts=await pool.query<{kind:string,n:number}>(
   'SELECT kind,count(*)::int AS n FROM tala_security_v2.abuse_alerts '+
   "WHERE action='orders.cancel' GROUP BY kind");
  const byKind=Object.fromEntries(alerts.rows.map(x=>[x.kind,x.n]));
  assert.ok((byKind.replay_burst??0)>=1);
  assert.ok((byKind.scope_probing??0)>=1);
  const duplicates=await pool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM ('+
   'SELECT subject_hash,action,kind,window_start '+
   'FROM tala_security_v2.abuse_alerts '+
   'GROUP BY subject_hash,action,kind,window_start '+
   'HAVING count(*)>1) duplicates');
  assert.equal(duplicates.rows[0]!.n,0,
   'one abuse alert per subject/action/kind/window');
  const metrics=await readSecurityMetrics(pool,{canMonitorSecurity:true});
  assert.equal(metrics.aggregateOnly,true);
  assert.ok(metrics.alerts.some(x=>x.kind==='replay_burst'));
  assert.equal(Object.hasOwn(metrics,'subject_hash'),false);
  await assert.rejects(pool.query('DELETE FROM tala_security_v2.abuse_alerts'),
   /SECURITY_AUDIT_IMMUTABLE/);
 }finally{await pool.end();}
});

test('M9 LAB2 rate abuse alerts and grant revocation expiry maintenance',
 {skip:!enabled,timeout:80000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 try{
  const subject=id(),resource=id();
  const attempts=await Promise.all(Array.from({length:7},()=>
   authorizeSecurityAction(config(pool),{
    grant:grant(subject,resource,'finance.payout.request'),
    action:'finance.payout.request',resourceId:resource
   })));
  assert.equal(attempts.filter(x=>x.code==='M9_ALLOW').length,3);
  assert.equal(attempts.filter(x=>x.code==='M9_RATE_LIMITED').length,4);
  const alerts=await readSecurityMetrics(pool,{canMonitorSecurity:true});
  assert.ok(alerts.alerts.some(x=>x.kind==='rate_pressure'&&
   x.action==='finance.payout.request'));
  const revoked=grant(id(),resource,'orders.cancel','session');
  await revokeSecurityGrant(config(pool),{canRevokeSecurity:true},revoked);
  const row=await pool.query<{grant_id:string}>(
   'SELECT grant_id FROM tala_security_v2.grant_revocations '+
   'ORDER BY revoked_at DESC LIMIT 1');
  const target=row.rows[0]!.grant_id;
  await pool.query('UPDATE tala_security_v2.grant_revocations '+
   "SET expires_at=clock_timestamp()-interval '1 minute' "+
   'WHERE grant_id=$1::uuid',[target]);
  const done=await pruneExpiredSecurityState(pool,{canMaintainSecurity:true});
  assert.ok(done.expiredRevocations>=1);
 }finally{await pool.end();}
});
