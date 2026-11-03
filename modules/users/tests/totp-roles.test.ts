import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {UsersError} from '../src/domain.js';
import {registerCredentialedPendingUser,loginLabUser,
  beginLabTotpEnrollment,confirmLabTotpEnrollment,
  readAuthenticatedProfile,readMyIdentityRole,requireLabAccountRole} from '../src/auth.js';
import {issueLabEmailChallenge,verifyLabEmailChallenge} from '../src/store.js';
import {totpCode,decodeBase32,encodeBase32,sealTotp,unsealTotp,
  matchTotp} from '../src/totp.js';

const url=process.env.USERS_CI_URL??'';
const enabled=/\/tala_users_v2_test(?:$|\?)/.test(url);
const authSecret=randomBytes(32),emailSecret=randomBytes(32),
  totpSecret=randomBytes(32),pass='ClavePrivada!2026-Tala';
const key=()=> 'm4-totp-'+randomUUID();
const fail=(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,
  (e:unknown)=>e instanceof UsersError&&e.code===code);
const pool=()=>new pg.Pool({connectionString:url,max:10});
async function active(db:pg.Pool){
  const email='staff.'+randomUUID()+'@example.com';
  const r=await registerCredentialedPendingUser(db,{
    email,displayName:'Cuenta Protegida',password:pass,
    secret:authSecret,idempotencyKey:key()
  });
  const userId=r.user.id;
  const proof=await issueLabEmailChallenge(db,{userId,secret:emailSecret});
  await verifyLabEmailChallenge(db,{userId,actorId:userId,
    token:proof.token,secret:emailSecret,expectedVersion:1,
    idempotencyKey:key()});
  return {userId,email};
}
test('M4 TOTP pure: ciphertext binds to identity, 6 digits, drift and replay denied',()=>{
  const original=randomBytes(20);
  const base=encodeBase32(original);
  assert.deepEqual(decodeBase32(base),original);
  const id=randomUUID(),sealed=sealTotp(id,base,totpSecret);
  assert.match(sealed.iv,/^[a-f0-9]{24}$/);
  assert.match(sealed.tag,/^[a-f0-9]{32}$/);
  assert.equal(sealed.cipher.length,40);
  assert.equal(unsealTotp(id,{
    secret_iv_hex:sealed.iv,secret_cipher_hex:sealed.cipher,
    secret_tag_hex:sealed.tag
  },totpSecret),base);
  assert.throws(()=>unsealTotp(randomUUID(),{
    secret_iv_hex:sealed.iv,secret_cipher_hex:sealed.cipher,
    secret_tag_hex:sealed.tag
  },totpSecret));
  const frame=Math.floor(Date.now()/30000);
  const code=totpCode(base,frame);
  assert.match(code,/^\d{6}$/);
  assert.equal(matchTotp(base,code,-1n),BigInt(frame));
  assert.equal(matchTotp(base,code,BigInt(frame)),null);
  assert.equal(matchTotp(base,'abcdef',-1n),null);
});
test('M4 privileged account needs enrolled MFA, changing role revokes sessions',
  {skip:!enabled,timeout:120000},async()=>{
  const db=pool();
  try{
    const {userId,email}=await active(db);
    const first=await loginLabUser(db,{email,password:pass,secret:authSecret});
    assert.deepEqual(await readMyIdentityRole(db,{
      sessionToken:first.sessionToken,secret:authSecret
    }),{userId,role:'customer'});
    await fail(()=>requireLabAccountRole(db,{
      sessionToken:first.sessionToken,secret:authSecret,
      allowedRoles:['staff','owner']
    }),'USERS_ROLE_DENIED');
    await assert.rejects(db.query(
      "UPDATE tala_users_v2.account_roles SET role='staff' WHERE account_id=$1",
      [userId]),(e:unknown)=>e instanceof Error&&
      e.message.includes('USERS_PRIVILEGED_MFA_REQUIRED'));
    await fail(()=>beginLabTotpEnrollment(db,{
      sessionToken:first.sessionToken,secret:authSecret,
      totpSecret,currentPassword:'incorrecta'
    }),'USERS_INVALID_CREDENTIALS');
    const begun=await beginLabTotpEnrollment(db,{
      sessionToken:first.sessionToken,secret:authSecret,
      totpSecret,currentPassword:pass
    });
    assert.match(begun.secretBase32,/^[A-Z2-7]{32}$/);
    const raw=await db.query(
      'SELECT secret_cipher_hex FROM tala_users_v2.user_totp WHERE account_id=$1',
      [userId]);
    assert.ok(!JSON.stringify(raw.rows).includes(begun.secretBase32));
    const frame=Math.floor(Date.now()/30_000);
    await fail(()=>confirmLabTotpEnrollment(db,{
      sessionToken:first.sessionToken,secret:authSecret,
      totpSecret,code:'000000'
    }),'USERS_TOTP_INVALID');
    const enabledFactor=await confirmLabTotpEnrollment(db,{
      sessionToken:first.sessionToken,secret:authSecret,totpSecret,
      code:totpCode(begun.secretBase32,frame)
    });
    assert.equal(enabledFactor.mfaEnabled,true);
    await fail(()=>readAuthenticatedProfile(db,{
      sessionToken:first.sessionToken,secret:authSecret
    }),'USERS_SESSION_INVALID');
    await db.query(
      "UPDATE tala_users_v2.account_roles SET role='staff' WHERE account_id=$1",
      [userId]);
    await fail(()=>loginLabUser(db,{email,password:pass,
      secret:authSecret}),'USERS_MFA_REQUIRED');
    await fail(()=>loginLabUser(db,{email,password:pass,
      secret:authSecret,totpSecret,totpCode:'notcode'
    }),'USERS_MFA_REQUIRED');
    const login=await loginLabUser(db,{email,password:pass,
      secret:authSecret,totpSecret,
      totpCode:totpCode(begun.secretBase32,frame+1)});
    assert.match(login.sessionToken,/^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(await readMyIdentityRole(db,{
      sessionToken:login.sessionToken,secret:authSecret
    }),{userId,role:'staff'});
    const verified=await db.query(
      'SELECT mfa_verified FROM tala_users_v2.sessions WHERE account_id=$1 AND revoked_at IS NULL',
      [userId]);
    assert.ok(verified.rows.every(x=>x.mfa_verified===true));
    await fail(()=>loginLabUser(db,{email,password:pass,
      secret:authSecret,totpSecret,
      totpCode:totpCode(begun.secretBase32,frame+1)
    }),'USERS_MFA_REQUIRED');
    assert.deepEqual(await requireLabAccountRole(db,{
      sessionToken:login.sessionToken,secret:authSecret,
      allowedRoles:['staff']
    }),{userId,role:'staff'});
    await db.query(
      "UPDATE tala_users_v2.account_roles SET role='customer' WHERE account_id=$1",
      [userId]);
    await fail(()=>readAuthenticatedProfile(db,{
      sessionToken:login.sessionToken,secret:authSecret
    }),'USERS_SESSION_INVALID');
  }finally{await db.end();}
});
