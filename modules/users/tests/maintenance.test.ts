import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {registerCredentialedPendingUser,loginLabUser,logoutLabSession,
  issueLabPasswordRecovery,beginLabTotpEnrollment} from '../src/auth.js';
import {issueLabEmailChallenge,verifyLabEmailChallenge} from '../src/store.js';
import {cleanupLabExpiredIdentityData} from '../src/maintenance.js';

const url=process.env.USERS_CI_URL??'';
const enabled=/\/tala_users_v2_test(?:$|\?)/.test(url);
const authSecret=randomBytes(32),emailSecret=randomBytes(32),totpSecret=randomBytes(32);
const pass='TalaSegura#2026-Cafeteria';
const key=()=> 'users-maintain-'+randomUUID();
async function create(db:pg.Pool,activate:boolean){
  const email='maintenance.'+randomUUID()+'@example.com';
  const user=await registerCredentialedPendingUser(db,{
    email,displayName:'Cuenta Retencion',password:pass,
    secret:authSecret,idempotencyKey:key()
  });
  if(activate){
    const proof=await issueLabEmailChallenge(db,{
      userId:user.user.id,secret:emailSecret});
    await verifyLabEmailChallenge(db,{userId:user.user.id,actorId:user.user.id,
      token:proof.token,secret:emailSecret,
      expectedVersion:1,idempotencyKey:key()});
  }
  return {email,id:user.user.id};
}
test('M4 retention: only old security artifacts removed, audit and active sessions remain',
 {skip:!enabled,timeout:120000},async()=>{
  const db=new pg.Pool({connectionString:url,max:10});
  try{
    const active=await create(db,true);
    const pending=await create(db,false);
    const proof=await issueLabEmailChallenge(db,{
      userId:pending.id,secret:emailSecret
    });
    assert.match(proof.token,/^[A-Za-z0-9_-]{43}$/);
    const expired=await loginLabUser(db,{email:active.email,password:pass,
      secret:authSecret});
    await logoutLabSession(db,{sessionToken:expired.sessionToken,secret:authSecret});
    const current=await loginLabUser(db,{email:active.email,password:pass,
      secret:authSecret});
    await issueLabPasswordRecovery(db,{email:active.email,secret:emailSecret});
    await beginLabTotpEnrollment(db,{sessionToken:current.sessionToken,
      secret:authSecret,totpSecret,currentPassword:pass});
    const before=(await db.query(
      'SELECT count(*)::int AS n FROM tala_users_v2.account_audit WHERE account_id=$1',
      [active.id])).rows[0].n;
    await db.query(
      "UPDATE tala_users_v2.sessions SET "+
      "created_at=clock_timestamp()-interval '45 days',"+
      "expires_at=clock_timestamp()-interval '44 days' "+
      "WHERE account_id=$1 AND revoked_at IS NOT NULL",[active.id]);
    await db.query(
      "UPDATE tala_users_v2.email_challenges SET "+
      "issued_at=clock_timestamp()-interval '9 days',"+
      "expires_at=clock_timestamp()-interval '9 days'+interval '10 minutes' "+
      "WHERE account_id=$1",[pending.id]);
    await db.query(
      "UPDATE tala_users_v2.password_recovery SET "+
      "issued_at=clock_timestamp()-interval '9 days',"+
      "expires_at=clock_timestamp()-interval '9 days'+interval '10 minutes' "+
      "WHERE account_id=$1",[active.id]);
    await db.query(
      "UPDATE tala_users_v2.user_totp SET "+
      "updated_at=clock_timestamp()-interval '2 days' WHERE account_id=$1",
      [active.id]);
    const cleaned=await cleanupLabExpiredIdentityData(db);
    assert.ok(cleaned.sessionsDeleted>=1);
    assert.ok(cleaned.expiredEmailProofsDeleted>=1);
    assert.ok(cleaned.expiredRecoveryProofsDeleted>=1);
    assert.ok(cleaned.abandonedTotpEnrollmentsDeleted>=1);
    assert.equal(cleaned.auditRowsDeleted,0);
    assert.equal((await db.query(
      'SELECT count(*)::int AS n FROM tala_users_v2.account_audit WHERE account_id=$1',
      [active.id])).rows[0].n,before);
    const live=await db.query(
      'SELECT count(*)::int AS n FROM tala_users_v2.sessions WHERE account_id=$1 AND revoked_at IS NULL',
      [active.id]);
    assert.equal(live.rows[0].n,1);
    const again=await cleanupLabExpiredIdentityData(db);
    assert.equal(again.sessionsDeleted,0);
    assert.equal(again.abandonedTotpEnrollmentsDeleted,0);
  }finally{await db.end();}
});
