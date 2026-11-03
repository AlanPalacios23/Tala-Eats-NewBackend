import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {UsersError} from '../src/domain.js';
import {issueLabEmailChallenge,verifyLabEmailChallenge} from '../src/store.js';
import {
  registerCredentialedPendingUser,loginLabUser,
  issueLabPasswordRecovery,resetLabPassword,readAuthenticatedProfile
} from '../src/auth.js';
import {createUsersLabHttpServer} from '../src/http-lab.js';

const url=process.env.USERS_CI_URL??'';
const enabled=/\/tala_users_v2_test(?:$|\?)/.test(url);
const authSecret=randomBytes(32),mailSecret=randomBytes(32);
const key=()=> 'm4-recovery-'+randomUUID();
const first='Clave Inicial #Tala 2026!';
const newPassword='Nueva Clave #Tala 2026!';
const wrong=randomBytes(32).toString('base64url');
async function active(pool:pg.Pool){
  const email='reset.'+randomUUID()+'@example.com';
  const reg=await registerCredentialedPendingUser(pool,{
    email,displayName:'María Torres',password:first,secret:authSecret,
    idempotencyKey:key()
  });
  const id=reg.user.id;
  const proof=await issueLabEmailChallenge(pool,{userId:id,secret:mailSecret});
  await verifyLabEmailChallenge(pool,{userId:id,actorId:id,
    token:proof.token,secret:mailSecret,expectedVersion:1,idempotencyKey:key()});
  return {email,id};
}
const fail=async(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,
  (e:unknown)=>e instanceof UsersError&&e.code===code);

test('M4 password recovery: five failed tokens persist, fresh token rotates credential and revokes sessions',
  {skip:!enabled,timeout:100000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:12});
  try{
    const user=await active(pool);
    const logged=await loginLabUser(pool,{
      email:user.email,password:first,secret:authSecret
    });
    const challenge=await issueLabPasswordRecovery(pool,{
      email:user.email,secret:mailSecret
    });
    assert.ok(challenge);
    assert.equal(challenge!.userId,user.id);
    assert.match(challenge!.token,/^[A-Za-z0-9_-]{43}$/);
    const rows=await pool.query(`
      SELECT token_digest FROM tala_users_v2.password_recovery
      WHERE account_id=$1::uuid`,[user.id]);
    assert.equal(rows.rows.length,1);
    assert.match(rows.rows[0].token_digest,/^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(rows.rows).includes(challenge!.token),false);
    assert.equal(await issueLabPasswordRecovery(pool,{
      email:user.email,secret:mailSecret
    }),null,'rate-limited recovery issues no fresh token');
    for(let n=1;n<=5;n++){
      await fail(()=>resetLabPassword(pool,{
        userId:user.id,token:wrong,newPassword,
        authSecret,emailSecret:mailSecret
      }),'USERS_RECOVERY_INVALID');
      assert.equal((await pool.query(`
        SELECT failed_attempts FROM tala_users_v2.password_recovery
        WHERE account_id=$1::uuid`,[user.id])).rows[0].failed_attempts,n);
    }
    await fail(()=>resetLabPassword(pool,{
      userId:user.id,token:challenge!.token,newPassword,
      authSecret,emailSecret:mailSecret
    }),'USERS_RECOVERY_INVALID');
    await pool.query(`
      UPDATE tala_users_v2.password_recovery
      SET issued_at=issued_at-interval '2 minutes'
      WHERE account_id=$1::uuid`,[user.id]);
    const replacement=await issueLabPasswordRecovery(pool,{
      email:user.email,secret:mailSecret
    });
    assert.ok(replacement);
    assert.notEqual(replacement!.token,challenge!.token);
    await fail(()=>resetLabPassword(pool,{
      userId:user.id,token:challenge!.token,newPassword,
      authSecret,emailSecret:mailSecret
    }),'USERS_RECOVERY_INVALID');
    const reset=await resetLabPassword(pool,{
      userId:user.id,token:replacement!.token,newPassword,
      authSecret,emailSecret:mailSecret
    });
    assert.equal(reset.passwordReset,true);
    assert.equal(reset.sessionsRevoked,true);
    await fail(()=>readAuthenticatedProfile(pool,{
      sessionToken:logged.sessionToken,secret:authSecret
    }),'USERS_SESSION_INVALID');
    await fail(()=>loginLabUser(pool,{
      email:user.email,password:first,secret:authSecret
    }),'USERS_INVALID_CREDENTIALS');
    const newLogin=await loginLabUser(pool,{
      email:user.email,password:newPassword,secret:authSecret
    });
    assert.ok(newLogin.sessionToken);
    await fail(()=>resetLabPassword(pool,{
      userId:user.id,token:replacement!.token,newPassword:'Otra Clave #Tala 2026!',
      authSecret,emailSecret:mailSecret
    }),'USERS_RECOVERY_INVALID');
    const audit=await pool.query(`
      SELECT action FROM tala_users_v2.account_audit
      WHERE account_id=$1::uuid AND action='password_reset'`,[user.id]);
    assert.equal(audit.rows.length,1);
  }finally{await pool.end();}
});

test('M4 password recovery endpoint is enumeration-safe with injected test mailbox',
  {skip:!enabled,timeout:90000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:12});
  const received:Array<{email:string,userId:string,token:string}>=[];
  const server=createUsersLabHttpServer({
    pool,authSecret,emailSecret:mailSecret,
    async sendVerification(){},
    async sendPasswordReset(email,token,userId){
      received.push({email,userId,token});
    }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const post=async(route:string,body:unknown)=>{
    const response=await fetch(base+route,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(body)
    });
    return {status:response.status,data:await response.json() as Record<string,unknown>};
  };
  try{
    const user=await active(pool);
    const missing=await post('/v1/users/forgot-password',{
      email:'unknown.'+randomUUID()+'@example.com'
    });
    assert.equal(missing.status,202);
    assert.deepEqual(missing.data,{accepted:true});
    assert.equal(received.length,0);
    const known=await post('/v1/users/forgot-password',{email:user.email});
    assert.equal(known.status,202);
    assert.deepEqual(known.data,{accepted:true});
    assert.equal(received.length,1);
    assert.equal(received[0]?.email,user.email);
    assert.equal(received[0]?.userId,user.id);
    assert.equal(JSON.stringify(known.data).includes(received[0]!.token),false);
    const wrongUser=await post('/v1/users/reset-password',{
      userId:randomUUID(),token:received[0]!.token,newPassword
    });
    assert.equal(wrongUser.status,401);
    assert.equal(wrongUser.data.error,'USERS_RECOVERY_INVALID');
    const changed=await post('/v1/users/reset-password',{
      userId:user.id,token:received[0]!.token,newPassword
    });
    assert.equal(changed.status,200);
    assert.equal(changed.data.passwordReset,true);
    const reused=await post('/v1/users/reset-password',{
      userId:user.id,token:received[0]!.token,
      newPassword:'Otra Nueva Clave #Tala 2026!'
    });
    assert.equal(reused.status,401);
    assert.equal((await post('/v1/users/login',{email:user.email,
      password:first})).status,401);
    assert.equal((await post('/v1/users/login',{email:user.email,
      password:newPassword})).status,200);
  }finally{
    await new Promise<void>((resolve,reject)=>
      server.close(e=>e?reject(e):resolve()));
    await pool.end();
  }
});
