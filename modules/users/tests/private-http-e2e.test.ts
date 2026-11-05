import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {AddressInfo} from 'node:net';
import pg from 'pg';
import {createUsersLabHttpServer} from '../src/http-lab.js';
import {totpCode} from '../src/totp.js';
const url=process.env.USERS_CI_URL??'';
const enabled=/\/tala_users_v2_test(?:$|\?)/.test(url);
const key=()=> 'm4-http-full-'+randomUUID();
const pass='ContraSegura#Tala2026';
const address={label:'Casa',street:'Calle las Flores',exterior:'50',
  neighborhood:'Centro',city:'Tala',state:'Jalisco',postalCode:'45300'};
test('M4 HTTP LAB end-to-end profile, export, TOTP enrollment and privilege gate',
  {skip:!enabled,timeout:120000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:12});
  const authSecret=randomBytes(32),emailSecret=randomBytes(32),
    totpSecret=randomBytes(32);
  const sent:Array<{email:string,token:string,userId:string}>=[];
  const server=createUsersLabHttpServer({pool,authSecret,emailSecret,totpSecret,
    async sendVerification(email,token,userId){sent.push({email,token,userId});}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  async function req(method:string,path:string,body?:unknown,token?:string){
    const response=await fetch(base+path,{method,
      headers:{...(body!==undefined?{'content-type':'application/json'}:{}),
        ...(token?{authorization:'Bearer '+token}:{})},
      ...(body!==undefined?{body:JSON.stringify(body)}:{})
    });
    return {status:response.status,body:await response.json() as Record<string,unknown>};
  }
  try{
    const email='http-private.'+randomUUID()+'@example.com';
    const registered=await req('POST','/v1/users/register',{
      email,displayName:'Cuenta Prueba',password:pass,idempotencyKey:key()
    });
    assert.equal(registered.status,202);
    const id=String(registered.body.userId);
    const verified=await req('POST','/v1/users/verify-email',{
      userId:id,token:sent[0]?.token,expectedVersion:1,idempotencyKey:key()
    });
    assert.equal(verified.status,200);
    const signed=await req('POST','/v1/users/login',{email,password:pass});
    assert.equal(signed.status,200);
    const token=String(signed.body.sessionToken);
    assert.equal((await req('GET','/v1/users/role',undefined,token)).body.role,'customer');
    assert.equal((await req('GET','/v1/users/addresses',undefined,token)).status,200);
    assert.equal((await req('POST','/v1/users/addresses',{
      address,idempotencyKey:key()
    })).status,401);
    const created=await req('POST','/v1/users/addresses',{
      address,idempotencyKey:key()
    },token);
    assert.equal(created.status,201);
    const item=created.body.address as Record<string,unknown>;
    assert.equal(item.isDefault,true);
    assert.equal((await req('GET','/v1/users/addresses',undefined,token)).body
      .addresses instanceof Array,true);
    const prefs=await req('PUT','/v1/users/preferences',{
      locale:'es-MX',marketingOptIn:false
    },token);
    assert.equal(prefs.status,200);
    const exported=await req('GET','/v1/users/export',undefined,token);
    assert.equal(exported.status,200);
    const asText=JSON.stringify(exported.body);
    assert.equal(asText.includes(token),false);
    assert.equal(asText.includes(pass),false);
    assert.equal(exported.body.role,'customer');
    const begin=await req('POST','/v1/users/mfa/start',{
      currentPassword:pass
    },token);
    assert.equal(begin.status,200);
    const factor=String(begin.body.secretBase32);
    assert.match(factor,/^[A-Z2-7]{32}$/);
    const frame=Math.floor(Date.now()/30000);
    const confirmed=await req('POST','/v1/users/mfa/confirm',{
      code:totpCode(factor,frame)
    },token);
    assert.equal(confirmed.status,200);
    assert.equal(confirmed.body.mfaEnabled,true);
    assert.equal((await req('GET','/v1/users/me',undefined,token)).status,401);
    assert.equal((await req('POST','/v1/users/login',{
      email,password:pass
    })).status,401);
    const mfaLogin=await req('POST','/v1/users/login',{
      email,password:pass,totpCode:totpCode(factor,frame+1)
    });
    assert.equal(mfaLogin.status,200);
    const stronger=String(mfaLogin.body.sessionToken);
    assert.equal((await req('GET','/v1/users/role',undefined,stronger)).body.role,
      'customer');
    await pool.query(
      "UPDATE tala_users_v2.account_roles SET role='staff' WHERE account_id=$1",
      [id]);
    assert.equal((await req('GET','/v1/users/me',undefined,stronger)).status,401);
    assert.equal((await req('POST','/v1/users/login',{
      email,password:pass
    })).status,401);
  }finally{
    await new Promise<void>((resolve,reject)=>
      server.close(err=>err?reject(err):resolve()));
    await pool.end();
  }
});
