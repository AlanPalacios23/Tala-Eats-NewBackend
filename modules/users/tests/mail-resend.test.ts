import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {UsersError} from '../src/domain.js';
import {createResendMailSinks} from '../src/mail-resend.js';

const token=()=>randomBytes(32).toString('base64url');
const config={apiKey:'re_testing_not_real_secret_123456',
  from:'cuentas@example.com',
  verificationPage:'https://talaeats.example/verificar',
  recoveryPage:'https://talaeats.example/recuperar'};
const invalid=(work:()=>unknown)=>assert.throws(work,
  (e:unknown)=>e instanceof UsersError&&e.code==='USERS_MAIL_CONFIG_INVALID');
test('M4 email adapter refuses insecure URLs, bad keys or unverified structure',()=>{
  invalid(()=>createResendMailSinks({...config,
    verificationPage:'http://insecure.test/verify'}));
  invalid(()=>createResendMailSinks({...config,
    verificationPage:'https://user:pass@valid.test/path'}));
  invalid(()=>createResendMailSinks({...config,
    recoveryPage:'https://valid.test/reset?token=foo'}));
  invalid(()=>createResendMailSinks({...config,apiKey:'short'}));
});
test('M4 email delivery sends no secrets to logs or user, keeps token inside HTTPS fragment',
 async()=>{
  const calls:Array<{url:string,body:Record<string,unknown>,
    authorization:string,headers:Record<string,string>}>=[];
  const mock=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const headers=init?.headers as Record<string,string>;
    const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
    calls.push({url:String(input),body,
      authorization:headers.Authorization??'',headers});
    return new Response(JSON.stringify({id:'mock-provider-id'}),{status:200});
  }) as typeof fetch;
  const sink=createResendMailSinks({...config,fetchFn:mock});
  const id=randomUUID(),proof=token();
  await sink.sendVerification('PERSON@example.COM',proof,id);
  assert.equal(calls.length,1);
  assert.equal(calls[0]?.url,'https://api.resend.com/emails');
  assert.equal(calls[0]?.authorization,'Bearer '+config.apiKey);
  assert.deepEqual(calls[0]?.body.to,['person@example.com']);
  const body=calls[0]!.body;
  const message=String(body.text);
  assert.ok(message.includes('#'));
  assert.ok(message.includes(proof));
  const link=message.slice(message.indexOf('https://'));
  const u=new URL(link);
  assert.equal(u.search,'');
  assert.equal(u.hash.startsWith('#userId='),true);
  assert.equal(u.hash.includes(proof),true);
  assert.equal(body.subject,'Confirma tu correo — Tala Eats');
  await sink.sendPasswordReset('person@example.com',token(),id);
  assert.equal(calls.length,2);
  assert.equal(calls[1]?.body.subject,'Restablece tu contraseña — Tala Eats');
  assert.notEqual(calls[0]?.headers['Idempotency-Key'],
    calls[1]?.headers['Idempotency-Key']);
  assert.ok(!JSON.stringify(calls.map(x=>x.headers)).includes(proof));
});
test('M4 email adapter retries 429/503 with fixed idempotency and rejects failure',
 async()=>{
  let calls=0;const keys:string[]=[];
  const transient=(async(_input:RequestInfo|URL,init?:RequestInit)=>{
    calls++;
    keys.push((init?.headers as Record<string,string>)['Idempotency-Key']!);
    if(calls<3)return new Response('{}',{status:calls===1?429:503});
    return new Response(JSON.stringify({id:'ok-3'}),{status:201});
  }) as typeof fetch;
  const sender=createResendMailSinks({...config,fetchFn:transient});
  await sender.sendVerification('test@example.com',token(),randomUUID());
  assert.equal(calls,3);
  assert.equal(new Set(keys).size,1);
  const forbidden=(async()=>new Response('provider said token xyz',
    {status:403})) as typeof fetch;
  const rejected=createResendMailSinks({...config,fetchFn:forbidden});
  await assert.rejects(
    ()=>rejected.sendPasswordReset('test@example.com',token(),randomUUID()),
    (e:unknown)=>e instanceof UsersError&&
      e.code==='USERS_MAIL_DELIVERY_FAILED'&&
      !e.message.includes('token xyz')
  );
});
