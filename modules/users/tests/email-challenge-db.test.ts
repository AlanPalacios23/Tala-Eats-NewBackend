import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {UsersError} from '../src/domain.js';
import {
  registerPendingUser,issueLabEmailChallenge,verifyLabEmailChallenge,
  readLabUser,transitionLabUser
} from '../src/store.js';
const url=process.env.USERS_CI_URL??'';
const enabled=/\/tala_users_v2_test(?:$|\?)/.test(url);
const pepper=randomBytes(32);
const key=()=> 'm4-challenge-command-'+randomUUID();
const db=()=>new pg.Pool({connectionString:url,max:16,connectionTimeoutMillis:4000});
const user=async(pool:pg.Pool)=>{
  const account=await registerPendingUser(pool,{
    email:'verify.'+randomUUID()+'@example.com',
    displayName:'María Verificación',idempotencyKey:key()
  });
  return account.user.id;
};
const fail=async(fn:()=>Promise<unknown>,code:string)=>{
  await assert.rejects(fn,(e:unknown)=>e instanceof UsersError&&e.code===code);
};

test('M4 LAB email tokens are hashed, one-time, never accepted as forged SQL proof',
  {skip:!enabled,timeout:65000},async()=>{
  const pool=db();
  try{
    const id=await user(pool);
    await fail(()=>issueLabEmailChallenge(pool,{
      userId:id,secret:Buffer.alloc(8)
    }),'USERS_VERIFICATION_CONFIG_INVALID');
    const issued=await issueLabEmailChallenge(pool,{userId:id,secret:pepper});
    assert.match(issued.token,/^[A-Za-z0-9_-]{43}$/);
    await fail(()=>issueLabEmailChallenge(pool,{
      userId:id,secret:pepper
    }),'USERS_VERIFICATION_COOLDOWN');
    const sql=await pool.query(`
      SELECT token_digest,failed_attempts,consumed_at FROM
      tala_users_v2.email_challenges WHERE account_id=$1`,[id]);
    assert.equal(sql.rows.length,1);
    assert.match(sql.rows[0].token_digest,/^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(sql.rows).includes(issued.token),false);
    await assert.rejects(pool.query(`
      UPDATE tala_users_v2.accounts SET
      status='active',email_verified_at=clock_timestamp(),
      version=version+1,updated_at=clock_timestamp()
      WHERE id=$1`,[id]),(e:unknown)=>
        e instanceof Error && 'code' in e && e.code==='23514' &&
        e.message.includes('USERS_VERIFICATION_PROOF_REQUIRED'));
    await fail(()=>transitionLabUser(pool,{
      userId:id,actorId:id,action:'email_verified',expectedVersion:1,
      idempotencyKey:key()
    }),'USERS_VERIFICATION_PROOF_REQUIRED');
    await fail(()=>verifyLabEmailChallenge(pool,{
      userId:id,actorId:randomUUID(),token:issued.token,
      secret:pepper,expectedVersion:1,idempotencyKey:key()
    }),'USERS_VERIFICATION_ACTOR_DENIED');
    assert.equal((await pool.query(
      'SELECT failed_attempts FROM tala_users_v2.email_challenges WHERE account_id=$1',
      [id])).rows[0]?.failed_attempts,0);
    const result=await verifyLabEmailChallenge(pool,{
      userId:id,actorId:id,token:issued.token,
      secret:pepper,expectedVersion:1,idempotencyKey:key()
    });
    assert.equal(result.replayed,false);
    assert.equal(result.user.status,'active');
    assert.equal((await readLabUser(pool,id))?.status,'active');
    assert.equal((await pool.query(
      'SELECT consumed_at IS NOT NULL AS used FROM tala_users_v2.email_challenges WHERE account_id=$1',
      [id])).rows[0]?.used,true);
    const audits=await pool.query(`
      SELECT action,request_hash FROM tala_users_v2.account_audit
      WHERE account_id=$1`,[id]);
    assert.deepEqual(audits.rows.map(r=>r.action),
      ['register_pending','email_verified']);
    assert.ok(!JSON.stringify(audits.rows).includes(issued.token));
  }finally{await pool.end();}
});

test('M4 failed verification attempts persist after errors and lock account challenge',
  {skip:!enabled,timeout:65000},async()=>{
  const pool=db();
  try{
    const id=await user(pool);
    const issued=await issueLabEmailChallenge(pool,{userId:id,secret:pepper});
    const wrong=randomBytes(32).toString('base64url');
    for(let attempt=1;attempt<=5;attempt++){
      await fail(()=>verifyLabEmailChallenge(pool,{
        userId:id,actorId:id,token:wrong,secret:pepper,
        expectedVersion:1,idempotencyKey:key()
      }),'USERS_VERIFICATION_INVALID');
      const attempts=await pool.query(`
        SELECT failed_attempts FROM tala_users_v2.email_challenges
        WHERE account_id=$1`,[id]);
      assert.equal(attempts.rows[0]?.failed_attempts,attempt);
    }
    await fail(()=>verifyLabEmailChallenge(pool,{
      userId:id,actorId:id,token:issued.token,secret:pepper,
      expectedVersion:1,idempotencyKey:key()
    }),'USERS_VERIFICATION_INVALID');
    assert.equal((await readLabUser(pool,id))?.status,'pending_verification');
    assert.equal((await pool.query(`
      SELECT count(*)::int AS n FROM tala_users_v2.account_audit
      WHERE account_id=$1 AND action='email_verified'`,[id])).rows[0]?.n,0);
    // Simulate a LAB cooldown passage. Reissue replaces a locked digest,
    // never revives the exhausted token.
    await pool.query(`
      UPDATE tala_users_v2.email_challenges
      SET issued_at=issued_at-interval '2 minutes'
      WHERE account_id=$1`,[id]);
    const refreshed=await issueLabEmailChallenge(pool,{userId:id,secret:pepper});
    assert.notEqual(refreshed.token,issued.token);
    await fail(()=>verifyLabEmailChallenge(pool,{
      userId:id,actorId:id,token:issued.token,secret:pepper,
      expectedVersion:1,idempotencyKey:key()
    }),'USERS_VERIFICATION_INVALID');
    const newValid=await verifyLabEmailChallenge(pool,{
      userId:id,actorId:id,token:refreshed.token,secret:pepper,
      expectedVersion:1,idempotencyKey:key()
    });
    assert.equal(newValid.user.status,'active');
  }finally{await pool.end();}
});

test('M4 same valid email token racing requests activates only once',
  {skip:!enabled,timeout:65000},async()=>{
  const pool=db();
  try{
    const id=await user(pool);
    const {token}=await issueLabEmailChallenge(pool,{userId:id,secret:pepper});
    const commandKey=key();
    const concurrent=await Promise.allSettled(Array.from({length:10},()=>
      verifyLabEmailChallenge(pool,{userId:id,actorId:id,
        token,secret:pepper,expectedVersion:1,idempotencyKey:commandKey})
    ));
    assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,10);
    assert.equal(concurrent.filter(x=>x.status==='fulfilled'&&
      x.value.replayed===false).length,1);
    assert.equal(concurrent.filter(x=>x.status==='fulfilled'&&
      x.value.replayed===true).length,9);
    assert.equal((await readLabUser(pool,id))?.version,2);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS n FROM tala_users_v2.account_audit
      WHERE account_id=$1 AND action='email_verified'`,[id])).rows[0]?.n,1);
    await fail(()=>verifyLabEmailChallenge(pool,{
      userId:id,actorId:id,token,secret:pepper,
      expectedVersion:1,idempotencyKey:key()
    }),'USERS_VERIFICATION_STATE_DENIED');
  }finally{await pool.end();}
});

test('M4 expired challenge cannot verify, proof is bound to the correct identity',
  {skip:!enabled,timeout:65000},async()=>{
  const pool=db();
  try{
    const a=await user(pool),b=await user(pool);
    const proofA=await issueLabEmailChallenge(pool,{userId:a,secret:pepper});
    await issueLabEmailChallenge(pool,{userId:b,secret:pepper});
    await fail(()=>verifyLabEmailChallenge(pool,{
      userId:b,actorId:b,token:proofA.token,secret:pepper,
      expectedVersion:1,idempotencyKey:key()
    }),'USERS_VERIFICATION_INVALID');
    const count=await pool.query(`
      SELECT failed_attempts FROM tala_users_v2.email_challenges
      WHERE account_id=$1`,[b]);
    assert.equal(count.rows[0]?.failed_attempts,1);
    await pool.query(`
      UPDATE tala_users_v2.email_challenges
      SET issued_at=clock_timestamp()-interval '11 minutes',
          expires_at=clock_timestamp()-interval '1 minute'
      WHERE account_id=$1`,[a]);
    await fail(()=>verifyLabEmailChallenge(pool,{
      userId:a,actorId:a,token:proofA.token,secret:pepper,
      expectedVersion:1,idempotencyKey:key()
    }),'USERS_VERIFICATION_INVALID');
    assert.equal((await readLabUser(pool,a))?.status,'pending_verification');
  }finally{await pool.end();}
});
