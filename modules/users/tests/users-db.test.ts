import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {UsersError} from '../src/domain.js';
import {registerPendingUser,transitionLabUser,updateLabOwnProfile,
  readLabUser,issueLabEmailChallenge,verifyLabEmailChallenge} from '../src/store.js';

const url=process.env.USERS_CI_URL??'';
const enabled=/\/tala_users_v2_test(?:$|\?)/.test(url);
const key=()=> 'users-command-'+randomUUID();
const fail=async(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,
  (e:unknown)=>e instanceof UsersError&&e.code===code);
const pool=()=>new pg.Pool({connectionString:url,max:16,connectionTimeoutMillis:4000});
const actor=()=>randomUUID();
const challengeSecret=randomBytes(32);

test('M4 PostgreSQL: concurrent registration, email uniqueness and replay',
  {skip:!enabled,timeout:65000},async()=>{
  const db=pool();
  try{
    const email='Prueba.'+randomUUID().replaceAll('-','')+'@example.com';
    const command=key();
    const input={email,displayName:'María Pérez',idempotencyKey:command};
    const results=await Promise.all(Array.from({length:12},()=>
      registerPendingUser(db,input)));
    assert.equal(results.filter(r=>!r.replayed).length,1);
    assert.equal(results.filter(r=>r.replayed).length,11);
    const id=results[0]!.user.id;
    assert.equal(new Set(results.map(r=>r.user.id)).size,1);
    assert.equal(results[0]!.user.status,'pending_verification');
    assert.equal(results[0]!.user.email,email.toLowerCase());
    assert.equal(results[0]!.user.version,1);
    assert.equal((await db.query(
      'SELECT count(*)::int AS n FROM tala_users_v2.accounts WHERE email_normalized=$1',
      [email.toLowerCase()])).rows[0]?.n,1);
    await fail(()=>registerPendingUser(db,{
      ...input,idempotencyKey:key()
    }),'USERS_EMAIL_OR_COMMAND_CONFLICT');
    await fail(()=>registerPendingUser(db,{
      ...input,displayName:'Nombre Distinto'
    }),'USERS_EMAIL_OR_COMMAND_CONFLICT');
    await fail(()=>registerPendingUser(db,{
      ...input,email:'another.'+randomUUID()+'@example.com'
    }),'USERS_UNIQUE_CONFLICT');
    assert.equal((await db.query(
      'SELECT count(*)::int AS n FROM tala_users_v2.account_audit WHERE account_id=$1',
      [id])).rows[0]?.n,1);
    const saved=await readLabUser(db,id);
    assert.equal(saved?.displayName,'María Pérez');
    assert.equal(await readLabUser(db,randomUUID()),null);
  }finally{await db.end();}
});

test('M4 PostgreSQL: verified activation, profile, suspension and deletion audit',
 {skip:!enabled,timeout:65000},async()=>{
  const db=pool();
  try{
    const email='customer.'+randomUUID()+'@example.com';
    const created=await registerPendingUser(db,{
      email,displayName:'José Martínez',idempotencyKey:key()
    });
    const userId=created.user.id,staff=actor();
    await fail(()=>updateLabOwnProfile(db,{
      userId,actorId:userId,displayName:'José M.',expectedVersion:1,
      idempotencyKey:key()
    }),'USERS_PROFILE_STATE_DENIED');
    const verifyKey=key();
    await fail(()=>transitionLabUser(db,{userId,actorId:staff,
      action:'email_verified',expectedVersion:1,idempotencyKey:key()
    }),'USERS_VERIFICATION_PROOF_REQUIRED');
    const challenge=await issueLabEmailChallenge(db,{
      userId,secret:challengeSecret
    });
    const verified=await verifyLabEmailChallenge(db,{userId,actorId:userId,
      token:challenge.token,secret:challengeSecret,
      expectedVersion:1,idempotencyKey:verifyKey});
    assert.equal(verified.user.status,'active');
    assert.equal(verified.user.version,2);
    const replay=await verifyLabEmailChallenge(db,{userId,actorId:userId,
      token:challenge.token,secret:challengeSecret,
      expectedVersion:1,idempotencyKey:verifyKey});
    assert.equal(replay.replayed,true);
    assert.equal(replay.appliedStatus,'active');
    await fail(()=>verifyLabEmailChallenge(db,{userId,actorId:userId,
      token:challenge.token,secret:challengeSecret,
      expectedVersion:1,idempotencyKey:key()
    }),'USERS_VERIFICATION_STATE_DENIED');
    await fail(()=>updateLabOwnProfile(db,{
      userId,actorId:staff,displayName:'Otro nombre',expectedVersion:2,
      idempotencyKey:key()
    }),'USERS_PROFILE_ACTOR_DENIED');
    const profileKey=key();
    const edited=await updateLabOwnProfile(db,{userId,actorId:userId,
      displayName:'José María Martínez',expectedVersion:2,
      idempotencyKey:profileKey});
    assert.equal(edited.user.displayName,'José María Martínez');
    assert.equal(edited.user.version,3);
    assert.equal((await updateLabOwnProfile(db,{userId,actorId:userId,
      displayName:'José María Martínez',expectedVersion:2,
      idempotencyKey:profileKey})).replayed,true);
    const suspended=await transitionLabUser(db,{userId,actorId:staff,
      action:'suspend',expectedVersion:3,idempotencyKey:key()});
    assert.equal(suspended.user.status,'suspended');
    await fail(()=>updateLabOwnProfile(db,{userId,actorId:userId,
      displayName:'Nuevo nombre',expectedVersion:4,idempotencyKey:key()
    }),'USERS_PROFILE_STATE_DENIED');
    const deletedRequest=await transitionLabUser(db,{userId,actorId:userId,
      action:'request_deletion',expectedVersion:4,idempotencyKey:key()});
    assert.equal(deletedRequest.user.status,'deletion_requested');
    const finalized=await transitionLabUser(db,{userId,actorId:staff,
      action:'finalize_deletion',expectedVersion:5,idempotencyKey:key()});
    assert.equal(finalized.user.status,'deleted');
    assert.equal(finalized.user.version,6);
    assert.equal(finalized.user.displayName,'Cuenta eliminada');
    assert.equal(finalized.user.email,'deleted.'+userId+'@users.invalid');
    assert.equal((await readLabUser(db,userId))?.status,'deleted');
    assert.equal((await db.query(
      'SELECT count(*)::int AS n FROM tala_users_v2.email_challenges WHERE account_id=$1',
      [userId])).rows[0]?.n,0,
      'Deletion must discard temporary verification digest and attempts');
    await fail(()=>transitionLabUser(db,{userId,actorId:staff,
      action:'reinstate',expectedVersion:6,idempotencyKey:key()
    }),'USERS_STATE_TRANSITION_DENIED');
    const history=await db.query(
      'SELECT action,from_status,to_status FROM tala_users_v2.account_audit WHERE account_id=$1 ORDER BY id',
      [userId]);
    assert.deepEqual(history.rows.map(x=>x.action),[
      'register_pending','email_verified','profile_updated','suspend',
      'request_deletion','finalize_deletion'
    ]);
    const raw=JSON.stringify(history.rows);
    assert.ok(!raw.includes(email));
    assert.ok(!raw.includes('José'));
    // Tombstoned identity releases the old email; historical audit remains.
    const fresh=await registerPendingUser(db,{email,
      displayName:'Cuenta Nueva',idempotencyKey:key()});
    assert.notEqual(fresh.user.id,userId);
    assert.equal(fresh.user.status,'pending_verification');
  }finally{await db.end();}
});

test('M4 PostgreSQL: concurrent versions allow exactly one profile change',
 {skip:!enabled,timeout:65000},async()=>{
  const db=pool();
  try{
    const created=await registerPendingUser(db,{
      email:'race.'+randomUUID()+'@example.com',
      displayName:'Nombre Original',idempotencyKey:key()
    });
    const userId=created.user.id;
    const issued=await issueLabEmailChallenge(db,{
      userId,secret:challengeSecret
    });
    await verifyLabEmailChallenge(db,{userId,actorId:userId,
      token:issued.token,secret:challengeSecret,
      expectedVersion:1,idempotencyKey:key()});
    const concurrent=await Promise.allSettled([
      updateLabOwnProfile(db,{userId,actorId:userId,
        displayName:'Nombre A',expectedVersion:2,idempotencyKey:key()}),
      updateLabOwnProfile(db,{userId,actorId:userId,
        displayName:'Nombre B',expectedVersion:2,idempotencyKey:key()})
    ]);
    assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
    assert.equal((concurrent.find(x=>x.status==='rejected') as
      PromiseRejectedResult).reason.code,'USERS_VERSION_CONFLICT');
    const saved=await readLabUser(db,userId);
    assert.equal(saved?.version,3);
    assert.ok(['Nombre A','Nombre B'].includes(saved!.displayName));
    assert.equal((await db.query(
      "SELECT count(*)::int AS n FROM tala_users_v2.account_audit WHERE account_id=$1 AND action='profile_updated'",
      [userId])).rows[0]?.n,1);
  }finally{await db.end();}
});

test('M4 PostgreSQL: direct SQL cannot bypass status, ownership or audit immutability',
 {skip:!enabled,timeout:65000},async()=>{
  const db=pool();
  try{
    const created=await registerPendingUser(db,{
      email:'safety.'+randomUUID()+'@example.com',
      displayName:'Cuenta Segura',idempotencyKey:key()
    });
    const id=created.user.id;
    const invalid=[
      db.query("UPDATE tala_users_v2.accounts SET status='active',version=version+1 WHERE id=$1",[id]),
      db.query("UPDATE tala_users_v2.accounts SET status='active',email_verified_at=clock_timestamp(),version=version+1 WHERE id=$1",[id]),
      db.query("UPDATE tala_users_v2.accounts SET email_normalized='hijack@example.com',version=version+1 WHERE id=$1",[id]),
      db.query("UPDATE tala_users_v2.accounts SET version=version+2 WHERE id=$1",[id]),
      db.query("DELETE FROM tala_users_v2.accounts WHERE id=$1",[id]),
      db.query("DELETE FROM tala_users_v2.account_audit WHERE account_id=$1",[id])
    ];
    const results=await Promise.allSettled(invalid);
    assert.ok(results.every(x=>x.status==='rejected'));
    assert.equal((await readLabUser(db,id))?.status,'pending_verification');
    assert.equal((await db.query(
      'SELECT count(*)::int AS n FROM tala_users_v2.account_audit WHERE account_id=$1',
      [id])).rows[0]?.n,1);
  }finally{await db.end();}
});
