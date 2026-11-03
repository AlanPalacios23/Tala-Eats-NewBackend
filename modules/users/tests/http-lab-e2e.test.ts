import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {createUsersLabHttpServer} from '../src/http-lab.js';
import {readLabUser} from '../src/store.js';

const url=process.env.USERS_CI_URL??'';
const enabled=/\/tala_users_v2_test(?:$|\?)/.test(url);
const key=()=> 'm4-http-command-'+randomUUID();
const password='Frase Segura #Tala Eats 2026!';
const changedPassword='Frase Renovada #Tala Eats 2026!';

test('M4 HTTP E2E loopback: register → simulated mailbox → verify → login → me → update → logout → password → deletion',
  {skip:!enabled,timeout:95000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:12});
  const mailbox:Array<{email:string,token:string}>=[];
  const server=createUsersLabHttpServer({
    pool,authSecret:randomBytes(32),emailSecret:randomBytes(32),
    async sendVerification(email,token){mailbox.push({email,token});}
  });
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>resolve());
  });
  const port=(server.address() as AddressInfo).port;
  const base='http://127.0.0.1:'+port;
  async function request(method:string,path:string,body?:unknown,sessionToken?:string,
    contentType='application/json'){
    const headers:Record<string,string>={};
    if(body!==undefined)headers['content-type']=contentType;
    if(sessionToken)headers.authorization='Bearer '+sessionToken;
    const response=await fetch(base+path,{method,headers,
      ...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json() as Record<string,unknown>,
      headers:response.headers};
  }
  const value=(d:Record<string,unknown>,name:string):string=>{
    assert.equal(typeof d[name],'string');
    return d[name] as string;
  };
  try{
    const health=await request('GET','/v1/users/health');
    assert.equal(health.status,200);
    assert.equal(health.data.status,'lab_ready');
    const email='http.'+randomUUID()+'@example.com';
    const registered=await request('POST','/v1/users/register',{
      email,displayName:'María González',password,idempotencyKey:key()
    });
    assert.equal(registered.status,202);
    assert.equal(registered.data.status,'pending_verification');
    const id=value(registered.data,'userId');
    assert.equal(mailbox.length,1);
    assert.equal(mailbox[0]?.email,email);
    assert.match(mailbox[0]!.token,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(JSON.stringify(registered.data).includes(mailbox[0]!.token),false);
    assert.equal(registered.headers.get('cache-control'),'no-store');
    assert.equal(registered.headers.get('access-control-allow-origin'),null);
    const early=await request('POST','/v1/users/login',{email,password});
    assert.equal(early.status,401);
    assert.equal(early.data.error,'USERS_INVALID_CREDENTIALS');
    const verification=await request('POST','/v1/users/verify-email',{
      userId:id,token:mailbox[0]!.token,expectedVersion:1,
      idempotencyKey:key()
    });
    assert.equal(verification.status,200);
    assert.equal(verification.data.status,'active');
    const login=await request('POST','/v1/users/login',{email,password});
    assert.equal(login.status,200);
    const session=value(login.data,'sessionToken');
    assert.match(session,/^[A-Za-z0-9_-]{43}$/);
    const me=await request('GET','/v1/users/me',undefined,session);
    assert.equal(me.status,200);
    assert.equal(me.data.id,id);
    assert.equal(me.data.displayName,'María González');
    assert.equal(me.data.version,2);
    const edited=await request('PATCH','/v1/users/me',{
      displayName:'María Elena González',expectedVersion:2,idempotencyKey:key()
    },session);
    assert.equal(edited.status,200);
    const editedUser=edited.data.user as Record<string,unknown>;
    assert.equal(editedUser.displayName,'María Elena González');
    assert.equal(editedUser.version,3);
    const without=await request('GET','/v1/users/me');
    assert.equal(without.status,401);
    const logout=await request('POST','/v1/users/logout',{},session);
    assert.equal(logout.status,200);
    assert.equal(logout.data.revoked,true);
    assert.equal((await request('GET','/v1/users/me',undefined,session)).status,401);
    const reopened=await request('POST','/v1/users/login',{email,password});
    const freshToken=value(reopened.data,'sessionToken');
    const rotation=await request('POST','/v1/users/change-password',{
      currentPassword:password,newPassword:changedPassword
    },freshToken);
    assert.equal(rotation.status,200);
    assert.equal(rotation.data.passwordChanged,true);
    assert.equal((await request('GET','/v1/users/me',undefined,freshToken)).status,401);
    assert.equal((await request('POST','/v1/users/login',{
      email,password
    })).status,401);
    const again=await request('POST','/v1/users/login',{
      email,password:changedPassword
    });
    assert.equal(again.status,200);
    const deletion=await request('POST','/v1/users/request-deletion',{
      expectedVersion:3,idempotencyKey:key()
    },value(again.data,'sessionToken'));
    assert.equal(deletion.status,200);
    assert.equal((deletion.data.user as Record<string,unknown>).status,
      'deletion_requested');
    assert.equal((await request('GET','/v1/users/me',undefined,
      value(again.data,'sessionToken'))).status,401);
    assert.equal((await readLabUser(pool,id))?.status,'deletion_requested');
  }finally{
    await new Promise<void>((resolve,reject)=>
      server.close(err=>err?reject(err):resolve()));
    await pool.end();
  }
});

test('M4 loopback HTTP rejects malformed input, spoofing, invalid bearer and unknown routes',
  {skip:!enabled,timeout:65000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:10});
  const mailbox:Array<{email:string,token:string}>=[];
  const server=createUsersLabHttpServer({
    pool,authSecret:randomBytes(32),emailSecret:randomBytes(32),
    async sendVerification(email,token){mailbox.push({email,token});}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  async function api(path:string,body:unknown,contentType='application/json'){
    const r=await fetch(base+path,{method:'POST',
      headers:{'content-type':contentType},
      body:JSON.stringify(body)});
    return {code:r.status,data:await r.json() as Record<string,unknown>};
  }
  try{
    const addr='validation.'+randomUUID()+'@example.com';
    assert.equal((await api('/v1/users/register',{
      email:addr,displayName:'Alicia Cuenta',
      password,idempotencyKey:key(),role:'admin'
    })).code,400);
    assert.equal(mailbox.length,0);
    const unknown=await api('/v1/users/checkout',{});
    assert.equal(unknown.code,404);
    const invalid=await api('/v1/users/register',{email:addr},'text/plain');
    assert.equal(invalid.code,415);
    assert.equal((await api('/v1/users/login',{
      email:'none.'+randomUUID()+'@example.com',password
    })).code,401);
    const r=await fetch(base+'/v1/users/me',{
      headers:{authorization:'Bearer NOT_A_VALID_TOKEN'}
    });
    assert.equal(r.status,401);
    assert.equal((await r.json() as Record<string,unknown>).error,'USERS_SESSION_INVALID');
  }finally{
    await new Promise<void>((resolve,reject)=>
      server.close(err=>err?reject(err):resolve()));
    await pool.end();
  }
});


test('M4 HTTP: failed mail delivery can be retried without duplicate signup or user enumeration',
  {skip:!enabled,timeout:70000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:10});
  const sent:Array<{email:string,userId:string,token:string}>=[];
  let failFirst=true;
  const server=createUsersLabHttpServer({
    pool,authSecret:randomBytes(32),emailSecret:randomBytes(32),
    async sendVerification(email,token,userId){
      if(failFirst){failFirst=false;throw Error('simulated sender unavailable');}
      sent.push({email,token,userId});
    }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  async function post(route:string,data:Record<string,unknown>){
    const response=await fetch(base+route,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(data)
    });
    return {status:response.status,body:await response.json() as Record<string,unknown>};
  }
  try{
    const email='resend.'+randomUUID()+'@example.com';
    const registered=await post('/v1/users/register',{
      email,displayName:'Alicia García',
      password,idempotencyKey:key()
    });
    assert.equal(registered.status,500,'outbound failure must not imply verified signup');
    assert.deepEqual(registered.body,{error:'USERS_INTERNAL_ERROR'});
    const account=await pool.query(`
      SELECT id,status FROM tala_users_v2.accounts WHERE email_normalized=$1`,
      [email]);
    assert.equal(account.rows.length,1);
    assert.equal(account.rows[0].status,'pending_verification');
    const initial=await post('/v1/users/resend-verification',{email});
    const absent=await post('/v1/users/resend-verification',{
      email:'absent.'+randomUUID()+'@example.com'
    });
    assert.equal(initial.status,202);
    assert.deepEqual(initial.body,absent.body);
    assert.equal(sent.length,0,'cooldown prevents immediate spam');
    await pool.query(`
      UPDATE tala_users_v2.email_challenges
      SET issued_at=issued_at-interval '2 minutes'
      WHERE account_id=$1::uuid`,[account.rows[0].id]);
    const retried=await post('/v1/users/resend-verification',{email});
    assert.equal(retried.status,202);
    assert.deepEqual(retried.body,{accepted:true});
    assert.equal(sent.length,1);
    assert.equal(sent[0]?.email,email);
    assert.equal(sent[0]?.userId,account.rows[0].id);
    assert.equal(JSON.stringify(retried.body).includes(sent[0]!.token),false);
    const verified=await post('/v1/users/verify-email',{
      userId:sent[0]!.userId,token:sent[0]!.token,
      expectedVersion:1,idempotencyKey:key()
    });
    assert.equal(verified.status,200);
    assert.equal(verified.body.status,'active');
    assert.equal((await post('/v1/users/resend-verification',{email})).status,202);
    assert.equal(sent.length,1,'active account cannot be issued more proofs');
  }finally{
    await new Promise<void>((resolve,reject)=>
      server.close(err=>err?reject(err):resolve()));
    await pool.end();
  }
});
