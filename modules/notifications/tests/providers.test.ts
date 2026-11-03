import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DeliveryFailure,type EmailMessage,type PushMessage} from '../src/worker.js';
import {createResendEmailSender,createFcmPushSender} from '../src/providers.js';
const recipient=randomUUID(),notification=randomUUID(),delivery=randomUUID();
const common={notificationId:notification,eventType:'order.confirmed',
  title:'Pedido confirmado',body:'Tu pedido está registrado.',
  deepLink:'/pedidos',data:{resourceId:randomUUID()},recipientId:recipient,
  app:'customer' as const,category:'transactional' as const,
  idempotencyKey:delivery};
test('M5 Resend adapter uses provider idempotency and never leaks secrets in text',async()=>{
  const requests:Array<{url:string,headers:Record<string,string>,body:Record<string,unknown>}>=[];
  const fetchFn=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const headers=init?.headers as Record<string,string>;
    const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
    requests.push({url:String(input),headers,body});
    return new Response(JSON.stringify({id:'mock-id'}),{status:200});
  }) as typeof fetch;
  const send=createResendEmailSender({apiKey:'re_mock_2026_abcdefghijkl',
    from:'notificaciones@example.com',fetchFn});
  const message:EmailMessage={...common,to:'usuario@example.com'};
  await send(message);
  assert.equal(requests[0]?.url,'https://api.resend.com/emails');
  assert.equal(requests[0]?.headers['Idempotency-Key'],delivery);
  assert.deepEqual(requests[0]?.body.to,['usuario@example.com']);
  assert.ok(JSON.stringify(requests[0]?.body).includes('Pedido confirmado'));
  assert.ok(!JSON.stringify(requests[0]?.body).includes('re_mock_2026'));
});
test('M5 FCM HTTP v1 supports Android, iOS and PWA web payloads',async()=>{
  const requests:Array<Record<string,unknown>>=[];
  const fetchFn=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    assert.equal(String(input),
      'https://fcm.googleapis.com/v1/projects/talaeats-lab/messages:send');
    const json=JSON.parse(String(init?.body)) as {message:Record<string,unknown>};
    requests.push(json.message);
    assert.equal((init?.headers as Record<string,string>).Authorization,
      'Bearer token_test_abcdefghijklmnopqrstuvwxyz');
    return new Response('{"name":"mock-success"}',{status:200});
  }) as typeof fetch;
  const send=createFcmPushSender({projectId:'talaeats-lab',
    getAccessToken:async()=> 'token_test_abcdefghijklmnopqrstuvwxyz',
    fetchFn});
  for(const platform of ['android','ios','web'] as const){
    const message:PushMessage={...common,platform,
      token:'firebase-registration-token-abcdefghijklmnopqrstuvwxyz'};
    await send(message);
  }
  assert.equal(requests.length,3);
  assert.ok('android' in requests[0]!);
  assert.ok('apns' in requests[1]!);
  assert.ok('webpush' in requests[2]!);
  assert.equal((requests[2]?.data as Record<string,unknown>).deepLink,'/pedidos');
});
test('M5 providers distinguish provider rejection from transient 429/503',async()=>{
  const transient=(async()=>new Response('retry',{status:503})) as typeof fetch;
  const permanent=(async()=>new Response('invalid',{status:400})) as typeof fetch;
  const msg:EmailMessage={...common,to:'usuario@example.com'};
  const args={apiKey:'re_mock_2026_abcdefghijkl',from:'notify@example.com'};
  await assert.rejects(()=>createResendEmailSender({...args,fetchFn:transient})(msg),
    (e:unknown)=>e instanceof DeliveryFailure&&!e.permanent&&
      e.code==='EMAIL_PROVIDER_TEMPORARY');
  await assert.rejects(()=>createResendEmailSender({...args,fetchFn:permanent})(msg),
    (e:unknown)=>e instanceof DeliveryFailure&&e.permanent&&
      e.code==='EMAIL_PROVIDER_REJECTED');
  assert.throws(()=>createFcmPushSender({
    projectId:'bad id',getAccessToken:async()=> 'some valid token'
  }));
});


test('M5 Resend 409 concurrent retry versus changed-payload permanent conflict',async()=>{
  const msg:EmailMessage={...common,to:'usuario@example.com'};
  const args={apiKey:'re_mock_2026_abcdefghijkl',from:'notify@example.com'};
  const concurrent=(async()=>new Response(
    JSON.stringify({name:'concurrent_idempotent_requests'}),{status:409}
  )) as typeof fetch;
  await assert.rejects(
    ()=>createResendEmailSender({...args,fetchFn:concurrent})(msg),
    (e:unknown)=>e instanceof DeliveryFailure&&!e.permanent&&
      e.code==='EMAIL_IDEMPOTENCY_CONCURRENT'
  );
  const changed=(async()=>new Response(
    JSON.stringify({name:'invalid_idempotent_request'}),{status:409}
  )) as typeof fetch;
  await assert.rejects(
    ()=>createResendEmailSender({...args,fetchFn:changed})(msg),
    (e:unknown)=>e instanceof DeliveryFailure&&e.permanent&&
      e.code==='EMAIL_IDEMPOTENCY_MISMATCH'
  );
});

test('M5 FCM: only explicit UNREGISTERED can revoke a device',async()=>{
  const msg:PushMessage={...common,platform:'web',
    token:'firebase-registration-token-test-abcdefghijklmnopqrstuvwxyz'};
  const args={projectId:'talaeats-lab',
    getAccessToken:async()=> 'token_test_abcdefghijklmnopqrstuvwxyz'};
  const scenarios=[
    {status:404,payload:{error:{status:'UNREGISTERED',details:[{
      '@type':'type.googleapis.com/google.firebase.fcm.v1.FcmError',
      errorCode:'UNREGISTERED'}]}},code:'FCM_UNREGISTERED',permanent:true},
    {status:404,payload:{error:{status:'NOT_FOUND',
      message:'Project does not exist'}},code:'FCM_PROJECT_OR_ROUTE_NOT_FOUND',
      permanent:false},
    {status:400,payload:{error:{status:'INVALID_ARGUMENT',details:[{
      '@type':'type.googleapis.com/google.rpc.BadRequest',
      fieldViolations:[]}]}},code:'FCM_INVALID_ARGUMENT',permanent:true}
  ] as const;
  for(const entry of scenarios){
    const fetchFn=(async()=>new Response(JSON.stringify(entry.payload),
      {status:entry.status})) as typeof fetch;
    const send=createFcmPushSender({...args,fetchFn});
    await assert.rejects(()=>send(msg),(error:unknown)=>
      error instanceof DeliveryFailure&&error.code===entry.code&&
      error.permanent===entry.permanent);
  }
});

test('M5 provider Retry-After is bounded and propagated without raw response data',async()=>{
  const msg:EmailMessage={...common,to:'persona@example.com'};
  const send=createResendEmailSender({
    apiKey:'re_mock_2026_abcdefghijkl',
    from:'notificaciones@example.com',
    fetchFn:(async()=>new Response('please retry',{status:429,
      headers:{'Retry-After':'120'}})) as typeof fetch
  });
  await assert.rejects(()=>send(msg),(e:unknown)=>
    e instanceof DeliveryFailure&&e.code==='EMAIL_PROVIDER_TEMPORARY'&&
      e.retryAfterSeconds===120);
  const push:PushMessage={...common,platform:'android',
    token:'fcm-validish-device-token-abcdefghijklmnopqrstuvwxyz'};
  const fcm=createFcmPushSender({
    projectId:'talaeats-lab',
    getAccessToken:async()=> 'oauth2_testing_token_abcdefghijklmnopqrstuvwxyz',
    fetchFn:(async()=>new Response('temporary',{status:503,
      headers:{'Retry-After':'99999'}})) as typeof fetch
  });
  await assert.rejects(()=>fcm(push),(e:unknown)=>
    e instanceof DeliveryFailure&&e.code==='FCM_TEMPORARY_OR_CONFIG'&&
      e.retryAfterSeconds===3600);
});
