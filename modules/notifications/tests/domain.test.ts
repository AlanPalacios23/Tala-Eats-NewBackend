import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {NotificationError,EVENT_CATALOG,render,uuid} from '../src/domain.js';
import {sealDeviceToken,unsealDeviceToken} from '../src/crypto.js';

const user=randomUUID();
test('M5 all four app audiences have independently typed notification events',()=>{
  assert.equal(new Set(Object.values(EVENT_CATALOG).map(x=>x.app)).size,4);
  assert.ok(Object.keys(EVENT_CATALOG).length>=20);
  for(const [eventType,event] of Object.entries(EVENT_CATALOG)){
    const n=render({sourceEventId:randomUUID(),recipientId:user,
      app:event.app,eventType:eventType as keyof typeof EVENT_CATALOG});
    assert.equal(n.category,event.category);
    assert.ok(n.deepLink.startsWith('/'));
    assert.ok(n.title.length>0&&n.title.length<=120);
    assert.ok(n.body.length>0&&n.body.length<=500);
    assert.equal(JSON.stringify(n).includes('@'),false);
  }
});
test('M5 rejects forged app audience, arbitrary PII fields, invalid identifiers and unknown events',()=>{
  const args={sourceEventId:randomUUID(),recipientId:user,
    app:'restaurant' as const,eventType:'order.confirmed' as const};
  assert.throws(()=>render(args),(e:unknown)=>
    e instanceof NotificationError&&e.code==='NOTIFICATIONS_AUDIENCE_MISMATCH');
  assert.throws(()=>render({...args,app:'customer',eventType:'hack.anything' as never}),
    (e:unknown)=>e instanceof NotificationError&&e.code==='NOTIFICATIONS_EVENT_UNKNOWN');
  assert.throws(()=>render({...args,app:'customer',email:'pii@example.com'} as never),
    (e:unknown)=>e instanceof NotificationError&&e.code==='NOTIFICATIONS_EVENT_INVALID');
  assert.throws(()=>uuid('not-a-uuid'));
  const a=render({...args,app:'customer',resourceId:randomUUID()});
  assert.ok(a.deepLink.includes('?ref='));
  const b=render({...args,app:'customer',sourceEventId:randomUUID()});
  assert.notEqual(a.contentFingerprint,b.contentFingerprint);
});
test('M5 device endpoints never store plaintext and ciphertext is identity bound',()=>{
  const secret=randomBytes(32),token='fcm:very-long-device-token-2026-xyz';
  const scope={recipientId:user,app:'courier' as const,platform:'android' as const};
  const a=sealDeviceToken({...scope,token,secret});
  const b=sealDeviceToken({...scope,token,secret});
  assert.equal(a.tokenDigest,b.tokenDigest);
  assert.notEqual(a.tokenCipher,b.tokenCipher);
  assert.ok(!JSON.stringify(a).includes(token));
  const row={recipient_id:user,app:scope.app,platform:scope.platform,
    token_iv:a.tokenIv,token_cipher:a.tokenCipher,token_tag:a.tokenTag};
  assert.equal(unsealDeviceToken(row,secret),token);
  assert.throws(()=>unsealDeviceToken({...row,recipient_id:randomUUID()},secret));
  assert.throws(()=>unsealDeviceToken(row,randomBytes(32)));
  assert.throws(()=>sealDeviceToken({...scope,token:'short',secret}));
  assert.throws(()=>sealDeviceToken({...scope,token,secret:Buffer.alloc(10)}));
});
