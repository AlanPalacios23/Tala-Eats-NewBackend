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
