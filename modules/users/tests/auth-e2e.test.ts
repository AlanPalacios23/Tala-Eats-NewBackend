import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {UsersError} from '../src/domain.js';
import {issueLabEmailChallenge,verifyLabEmailChallenge,
  transitionLabUser,readLabUser} from '../src/store.js';
import {checkNewPassword,registerCredentialedPendingUser,loginLabUser,
  readAuthenticatedProfile,updateAuthenticatedProfile,logoutLabSession,
  changeAuthenticatedPassword,requestAuthenticatedDeletion} from '../src/auth.js';

const url=process.env.USERS_CI_URL??'';
const enabled=/\/tala_users_v2_test(?:$|\?)/.test(url);
const pepper=randomBytes(32),emailPepper=randomBytes(32);
const pool=()=>new pg.Pool({connectionString:url,max:16,connectionTimeoutMillis:5000});
const key=()=> 'users-e2e-'+randomUUID();
const email=()=> 'e2e.'+randomUUID()+'@example.com';
const fail=async(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,
  (e:unknown)=>e instanceof UsersError&&e.code===code);
const pass='Clave Segura #Tala 2026!';
async function signup(db:pg.Pool){
  const addr=email();
  const command=key();
  const input={email:addr,displayName:'María Pérez',password:pass,
    secret:pepper,idempotencyKey:command};
  const created=await registerCredentialedPendingUser(db,input);
  return {addr,command,created,input,id:created.user.id};
}
async function activate(db:pg.Pool,id:string){
  const proof=await issueLabEmailChallenge(db,{userId:id,secret:emailPepper});
  return verifyLabEmailChallenge(db,{userId:id,actorId:id,token:proof.token,
    secret:emailPepper,expectedVersion:1,idempotencyKey:key()});
}

test('M4 E2E: secure signup → proof → login → profile → logout → rotate → deletion',
  {skip:!enabled,timeout:100000},async()=>{
  const db=pool();
  try{
    const account=await signup(db);
    assert.equal(account.created.user.status,'pending_verification');
    await fail(()=>loginLabUser(db,{email:account.addr,
      password:pass,secret:pepper}),'USERS_INVALID_CREDENTIALS');
    const storage=await db.query(`
      SELECT salt_hex,verifier_hex FROM tala_users_v2.password_credentials
      WHERE account_id=$1::uuid`,[account.id]);
    assert.equal(storage.rows.length,1);
    assert.match(storage.rows[0].salt_hex,/^[a-f0-9]{32}$/);
    assert.match(storage.rows[0].verifier_hex,/^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(storage.rows).includes(pass));
    const proof=await activate(db,account.id);
    assert.equal(proof.user.status,'active');
    const logged=await loginLabUser(db,{email:account.addr,
      password:pass,secret:pepper});
    assert.equal(logged.userId,account.id);
    assert.match(logged.sessionToken,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(logged.expiresInSeconds,43200);
    const stored=await db.query(`
      SELECT token_digest FROM tala_users_v2.sessions WHERE account_id=$1::uuid`,
      [account.id]);
    assert.equal(stored.rows.length,1);
    assert.match(stored.rows[0].token_digest,/^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(stored.rows).includes(logged.sessionToken));
    assert.equal((await readAuthenticatedProfile(db,{sessionToken:logged.sessionToken,
      secret:pepper})).status,'active');
    const edited=await updateAuthenticatedProfile(db,{sessionToken:logged.sessionToken,
      secret:pepper,displayName:'María del Carmen',expectedVersion:2,
      idempotencyKey:key()});
    assert.equal(edited.user.version,3);
    assert.equal(edited.user.displayName,'María del Carmen');
    await fail(()=>readAuthenticatedProfile(db,{
      sessionToken:logged.sessionToken,secret:randomBytes(32)
    }),'USERS_SESSION_INVALID');
    assert.equal((await logoutLabSession(db,{sessionToken:logged.sessionToken,
      secret:pepper})).revoked,true);
    assert.equal((await logoutLabSession(db,{sessionToken:logged.sessionToken,
      secret:pepper})).revoked,false);
    await fail(()=>readAuthenticatedProfile(db,{sessionToken:logged.sessionToken,
      secret:pepper}),'USERS_SESSION_INVALID');
    const live=await loginLabUser(db,{email:account.addr,password:pass,
      secret:pepper});
    const second=await loginLabUser(db,{email:account.addr,password:pass,
      secret:pepper});
    await fail(()=>changeAuthenticatedPassword(db,{
      sessionToken:live.sessionToken,secret:pepper,
      currentPassword:'wrong password',newPassword:'Nueva Clave #Tala 2026!'
    }),'USERS_INVALID_CREDENTIALS');
    const changed=await changeAuthenticatedPassword(db,{
      sessionToken:live.sessionToken,secret:pepper,currentPassword:pass,
      newPassword:'Nueva Clave #Tala 2026!'
    });
    assert.equal(changed.passwordChanged,true);
    assert.equal(changed.sessionsRevoked,true);
    for(const sessionToken of [live.sessionToken,second.sessionToken]){
      await fail(()=>readAuthenticatedProfile(db,{sessionToken,secret:pepper}),
        'USERS_SESSION_INVALID');
    }
    await fail(()=>loginLabUser(db,{email:account.addr,password:pass,
      secret:pepper}),'USERS_INVALID_CREDENTIALS');
    const newSession=await loginLabUser(db,{email:account.addr,
      password:'Nueva Clave #Tala 2026!',secret:pepper});
    const deleted=await requestAuthenticatedDeletion(db,{
      sessionToken:newSession.sessionToken,secret:pepper,
      expectedVersion:3,idempotencyKey:key()
    });
    assert.equal(deleted.user.status,'deletion_requested');
    await fail(()=>readAuthenticatedProfile(db,{
      sessionToken:newSession.sessionToken,secret:pepper
    }),'USERS_SESSION_INVALID');
    await fail(()=>loginLabUser(db,{email:account.addr,
      password:'Nueva Clave #Tala 2026!',secret:pepper}),
      'USERS_INVALID_CREDENTIALS');
    const finalized=await transitionLabUser(db,{
      userId:account.id,actorId:randomUUID(),action:'finalize_deletion',
      expectedVersion:4,idempotencyKey:key()
    });
    assert.equal(finalized.user.status,'deleted');
    assert.equal((await db.query(`
      SELECT count(*)::int AS n FROM tala_users_v2.password_credentials
      WHERE account_id=$1::uuid`,[account.id])).rows[0].n,0);
    assert.equal((await db.query(`
      SELECT count(*)::int AS n FROM tala_users_v2.sessions
      WHERE account_id=$1::uuid`,[account.id])).rows[0].n,0);
    assert.equal((await db.query(`
      SELECT count(*)::int AS n FROM tala_users_v2.email_challenges
      WHERE account_id=$1::uuid`,[account.id])).rows[0].n,0);
    const fresh=await registerCredentialedPendingUser(db,{
      email:account.addr,displayName:'Otra cuenta',password:pass,
      secret:pepper,idempotencyKey:key()
    });
    assert.notEqual(fresh.user.id,account.id);
    assert.equal(fresh.user.status,'pending_verification');
    const audit=await db.query(`
      SELECT action,request_hash FROM tala_users_v2.account_audit
      WHERE account_id=$1::uuid ORDER BY id`,[account.id]);
    assert.deepEqual(audit.rows.map(x=>x.action),[
      'register_pending','email_verified','profile_updated',
      'password_changed','request_deletion','finalize_deletion'
    ]);
    assert.ok(!JSON.stringify(audit.rows).includes(pass));
    assert.ok(!JSON.stringify(audit.rows).includes(account.addr));
  }finally{await db.end();}
});

test('M4 auth: concurrent signup is idempotent; no password confusion or disclosure',
  {skip:!enabled,timeout:100000},async()=>{
  const db=pool();
  try{
    const addr=email(),command=key(),input={
      email:addr,displayName:'Cuenta Protegida',password:pass,
      secret:pepper,idempotencyKey:command
    };
    const results=await Promise.all(Array.from({length:8},()=>
      registerCredentialedPendingUser(db,input)));
    assert.equal(results.filter(x=>!x.replayed).length,1);
    assert.equal(results.filter(x=>x.replayed).length,7);
    assert.equal(new Set(results.map(x=>x.user.id)).size,1);
    await fail(()=>registerCredentialedPendingUser(db,{
      ...input,password:'Clave Diferente #Tala 2026!'
    }),'USERS_EMAIL_OR_COMMAND_CONFLICT');
    await fail(()=>registerCredentialedPendingUser(db,{
      ...input,idempotencyKey:key()
    }),'USERS_EMAIL_OR_COMMAND_CONFLICT');
    const credential=await db.query(`
      SELECT count(*)::int AS n FROM tala_users_v2.password_credentials
      WHERE account_id=$1::uuid`,[results[0]!.user.id]);
    assert.equal(credential.rows[0].n,1);
  }finally{await db.end();}
});

test('M4 auth: five failed passwords lock account, then successful recovery after expiry',
  {skip:!enabled,timeout:100000},async()=>{
  const db=pool();
  try{
    const account=await signup(db);
    await activate(db,account.id);
    for(let i=1;i<=5;i++){
      await fail(()=>loginLabUser(db,{email:account.addr,
        password:'Wrong Password #Tala',secret:pepper}),
        'USERS_INVALID_CREDENTIALS');
    }
    const locked=await db.query(`
      SELECT failed_attempts,locked_until>clock_timestamp() AS locked
      FROM tala_users_v2.password_credentials WHERE account_id=$1::uuid`,
      [account.id]);
    assert.equal(locked.rows[0].failed_attempts,5);
    assert.equal(locked.rows[0].locked,true);
    await fail(()=>loginLabUser(db,{email:account.addr,password:pass,
      secret:pepper}),'USERS_INVALID_CREDENTIALS');
    // Fast-forward only in disposable LAB DB, never an auth bypass in runtime.
    await db.query(`
      UPDATE tala_users_v2.password_credentials
      SET locked_until=clock_timestamp()-interval '1 minute'
      WHERE account_id=$1::uuid`,[account.id]);
    const valid=await loginLabUser(db,{email:account.addr,password:pass,
      secret:pepper});
    assert.ok(valid.sessionToken);
    const reset=await db.query(`
      SELECT failed_attempts,locked_until FROM tala_users_v2.password_credentials
      WHERE account_id=$1::uuid`,[account.id]);
    assert.equal(reset.rows[0].failed_attempts,0);
    assert.equal(reset.rows[0].locked_until,null);
    await fail(()=>loginLabUser(db,{email:'unknown.'+randomUUID()+'@example.com',
      password:pass,secret:pepper}),'USERS_INVALID_CREDENTIALS');
    await fail(()=>loginLabUser(db,{email:account.addr,password:'bad',
      secret:pepper}),'USERS_INVALID_CREDENTIALS');
  }finally{await db.end();}
});

test('M4 auth: sessions expire, suspension revokes, reinstatement does not resurrect',
  {skip:!enabled,timeout:100000},async()=>{
  const db=pool();
  try{
    const account=await signup(db);
    await activate(db,account.id);
    const expired=await loginLabUser(db,{email:account.addr,password:pass,
      secret:pepper});
    await db.query(`
      UPDATE tala_users_v2.sessions SET
        created_at=clock_timestamp()-interval '13 hours',
        expires_at=clock_timestamp()-interval '2 hours'
      WHERE account_id=$1::uuid`,[account.id]);
    await fail(()=>readAuthenticatedProfile(db,{
      sessionToken:expired.sessionToken,secret:pepper
    }),'USERS_SESSION_INVALID');
    const session=await loginLabUser(db,{email:account.addr,password:pass,
      secret:pepper});
    const susp=await transitionLabUser(db,{userId:account.id,
      actorId:randomUUID(),action:'suspend',expectedVersion:2,
      idempotencyKey:key()});
    assert.equal(susp.user.status,'suspended');
    await fail(()=>readAuthenticatedProfile(db,{
      sessionToken:session.sessionToken,secret:pepper
    }),'USERS_SESSION_INVALID');
    await fail(()=>loginLabUser(db,{email:account.addr,password:pass,
      secret:pepper}),'USERS_INVALID_CREDENTIALS');
    const reinstated=await transitionLabUser(db,{
      userId:account.id,actorId:randomUUID(),action:'reinstate',
      expectedVersion:3,idempotencyKey:key()
    });
    assert.equal(reinstated.user.status,'active');
    await fail(()=>readAuthenticatedProfile(db,{
      sessionToken:session.sessionToken,secret:pepper
    }),'USERS_SESSION_INVALID');
    const newSession=await loginLabUser(db,{
      email:account.addr,password:pass,secret:pepper
    });
    assert.equal((await readAuthenticatedProfile(db,{
      sessionToken:newSession.sessionToken,secret:pepper
    })).id,account.id);
    // SQL cannot mint sessions for an unverified pending account.
    const pending=await signup(db);
    await assert.rejects(db.query(`
      WITH t AS (SELECT clock_timestamp() AS issued)
      INSERT INTO tala_users_v2.sessions
        (token_digest,account_id,created_at,expires_at)
      SELECT $1,$2::uuid,t.issued,t.issued+interval '1 hour' FROM t`,
      [randomBytes(32).toString('hex'),pending.id]),
      (e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code==='23514');
  }finally{await db.end();}
});

test('M4 auth: bearer profile updates are scoped, versioned and race-safe',
  {skip:!enabled,timeout:100000},async()=>{
  const db=pool();
  try{
    const a=await signup(db),b=await signup(db);
    await activate(db,a.id);
    await activate(db,b.id);
    const session=await loginLabUser(db,{email:a.addr,password:pass,secret:pepper});
    const concurrent=await Promise.allSettled([
      updateAuthenticatedProfile(db,{sessionToken:session.sessionToken,
        secret:pepper,displayName:'Nombre A',expectedVersion:2,
        idempotencyKey:key()}),
      updateAuthenticatedProfile(db,{sessionToken:session.sessionToken,
        secret:pepper,displayName:'Nombre B',expectedVersion:2,
        idempotencyKey:key()})
    ]);
    assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(concurrent.find(x=>x.status==='rejected')?.reason?.code,
      'USERS_VERSION_CONFLICT');
    assert.equal((await readLabUser(db,a.id))?.version,3);
    assert.equal((await readLabUser(db,b.id))?.displayName,'María Pérez');
    const result=await updateAuthenticatedProfile(db,{
      sessionToken:session.sessionToken,secret:pepper,
      displayName:'Nombre final',expectedVersion:3,idempotencyKey:key()
    });
    assert.equal(result.user.version,4);
    assert.equal(result.user.id,a.id);
    await fail(()=>updateAuthenticatedProfile(db,{
      sessionToken:session.sessionToken+'!',
      secret:pepper,displayName:'Falso',expectedVersion:4,
      idempotencyKey:key()
    }),'USERS_SESSION_INVALID');
  }finally{await db.end();}
});

test('M4 password strength gates reject trivially weak and invalid inputs',
  ()=>{
    for(const bad of ['a'.repeat(12),'password123456','123456789012','short',
      'clave\nnueva muy larga',42,null,'          ']){
      assert.throws(()=>checkNewPassword(bad),
        (e:unknown)=>e instanceof UsersError&&e.code==='USERS_PASSWORD_WEAK');
    }
    assert.equal(checkNewPassword(pass),pass);
  });
