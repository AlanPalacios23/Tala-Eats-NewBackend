import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {registerCredentialedPendingUser,loginLabUser,
  listAuthenticatedSessions,revokeAuthenticatedSession,
  revokeOtherAuthenticatedSessions,readAuthenticatedProfile} from '../src/auth.js';
import {issueLabEmailChallenge,verifyLabEmailChallenge} from '../src/store.js';
import {UsersError} from '../src/domain.js';

const url=process.env.USERS_CI_URL??'';
const enabled=/\/tala_users_v2_test(?:$|\?)/.test(url);
const secret=randomBytes(32),mail=randomBytes(32);
const key=()=> 'sessions-'+randomUUID();
const pool=()=>new pg.Pool({connectionString:url,max:12});
const password='SecurePassword!2026_Tala';
async function createActive(db:pg.Pool){
  const email='session.'+randomUUID()+'@example.com';
  const created=await registerCredentialedPendingUser(db,{
    email,displayName:'Cuenta Sesiones',password,
    secret,idempotencyKey:key()
  });
  const userId=created.user.id;
  const proof=await issueLabEmailChallenge(db,{userId,secret:mail});
  await verifyLabEmailChallenge(db,{
    userId,actorId:userId,token:proof.token,secret:mail,
    expectedVersion:1,idempotencyKey:key()
  });
  return email;
}
async function denied(db:pg.Pool,token:string){
  await assert.rejects(
    ()=>readAuthenticatedProfile(db,{sessionToken:token,secret}),
    (e:unknown)=>e instanceof UsersError&&e.code==='USERS_SESSION_INVALID'
  );
}

test('M4 sessions E2E: enumerate devices, revoke one, revoke others, preserve self',
 {skip:!enabled,timeout:90000},async()=>{
  const db=pool();
  try{
    const email=await createActive(db);
    const a=await loginLabUser(db,{email,password,secret});
    const b=await loginLabUser(db,{email,password,secret});
    const c=await loginLabUser(db,{email,password,secret});
    const first=await listAuthenticatedSessions(db,{
      sessionToken:a.sessionToken,secret
    });
    assert.equal(first.sessions.length,3);
    assert.equal(first.sessions.filter(x=>x.current).length,1);
    assert.ok(first.sessions.every(x=>/^[0-9a-f-]{36}$/.test(x.id)));
    assert.ok(!JSON.stringify(first).includes(a.sessionToken));
    assert.ok(!JSON.stringify(first).includes(b.sessionToken));
    const cList=await listAuthenticatedSessions(db,{
      sessionToken:c.sessionToken,secret
    });
    const cId=cList.sessions.find(x=>x.current)!.id;
    assert.equal((await revokeAuthenticatedSession(db,{
      sessionToken:a.sessionToken,secret,sessionId:cId
    })).revoked,true);
    await denied(db,c.sessionToken);
    assert.equal((await revokeAuthenticatedSession(db,{
      sessionToken:a.sessionToken,secret,sessionId:cId
    })).revoked,false);
    assert.equal((await revokeOtherAuthenticatedSessions(db,{
      sessionToken:a.sessionToken,secret
    })).revokedCount,1);
    await denied(db,b.sessionToken);
    assert.equal((await listAuthenticatedSessions(db,{
      sessionToken:a.sessionToken,secret
    })).sessions.length,1);
    assert.equal((await revokeOtherAuthenticatedSessions(db,{
      sessionToken:a.sessionToken,secret
    })).revokedCount,0);
    assert.equal((await readAuthenticatedProfile(db,{
      sessionToken:a.sessionToken,secret
    })).status,'active');
  }finally{await db.end();}
});

test('M4 sessions: cross-account revocation is denied and current session can self-revoke',
 {skip:!enabled,timeout:90000},async()=>{
  const db=pool();
  try{
    const first=await createActive(db),second=await createActive(db);
    const a=await loginLabUser(db,{email:first,password,secret});
    const b=await loginLabUser(db,{email:second,password,secret});
    const foreign=(await listAuthenticatedSessions(db,{
      sessionToken:b.sessionToken,secret
    })).sessions[0]!.id;
    assert.equal((await revokeAuthenticatedSession(db,{
      sessionToken:a.sessionToken,secret,sessionId:foreign
    })).revoked,false);
    assert.equal((await readAuthenticatedProfile(db,{
      sessionToken:b.sessionToken,secret
    })).status,'active');
    const own=(await listAuthenticatedSessions(db,{
      sessionToken:a.sessionToken,secret
    })).sessions[0]!.id;
    assert.equal((await revokeAuthenticatedSession(db,{
      sessionToken:a.sessionToken,secret,sessionId:own
    })).revoked,true);
    await denied(db,a.sessionToken);
    await assert.rejects(
      ()=>listAuthenticatedSessions(db,{sessionToken:a.sessionToken,secret}),
      (e:unknown)=>e instanceof UsersError&&e.code==='USERS_SESSION_INVALID'
    );
  }finally{await db.end();}
});
