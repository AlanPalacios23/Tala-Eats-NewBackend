import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHmac,randomUUID} from 'node:crypto';
import {PaymentError,uuid,integer,amount,currency,assertKeys} from '../src/domain.js';
import {verifyLabSignature} from '../src/webhook.js';

const fail=(run:()=>unknown,code:string)=>assert.throws(run,
 (e:unknown)=>e instanceof PaymentError&&e.code===code);
test('M8 money amounts are integer cents and exactly MXN',()=>{
 assert.equal(amount(49900),49900);
 assert.equal(amount(100_000_000),100_000_000);
 for(const input of [0,-1,1.5,NaN,Infinity,100_000_001,'49900',null]){
  fail(()=>amount(input),'M8_AMOUNT_INVALID');
 }
 fail(()=>currency('USD'),'M8_CURRENCY_INVALID');
 fail(()=>currency('mxn'),'M8_CURRENCY_INVALID');
 assert.equal(currency('MXN'),'MXN');
 fail(()=>uuid('abc'),'M8_UUID_INVALID');
 assert.equal(uuid(randomUUID()).length,36);
 fail(()=>integer(2.1,0,10,'BAD_INTEGER'),'BAD_INTEGER');
 fail(()=>assertKeys({actorId:randomUUID()},['amountCents']),
  'M8_REQUEST_INVALID');
});
test('M8 simulated webhook HMAC rejects tampering, stale time and invalid key',()=>{
 const secret=randomBytes(32),body=Buffer.from('{"kind":"test"}'),
  timestamp=String(Math.floor(Date.now()/1000));
 const signature='v1='+createHmac('sha256',secret).update(timestamp)
  .update('.').update(body).digest('hex');
 assert.doesNotThrow(()=>verifyLabSignature(secret,body,timestamp,signature));
 fail(()=>verifyLabSignature(secret,Buffer.from('{"kind":"other"}'),
  timestamp,signature),'M8_WEBHOOK_SIGNATURE_INVALID');
 fail(()=>verifyLabSignature(secret,body,
  String(Number(timestamp)-301),signature),'M8_WEBHOOK_TIMESTAMP_INVALID');
 fail(()=>verifyLabSignature(secret,body,timestamp,
  'v1='+'0'.repeat(64)),'M8_WEBHOOK_SIGNATURE_INVALID');
 fail(()=>verifyLabSignature(randomBytes(16),body,timestamp,signature),
  'M8_WEBHOOK_SECRET_INVALID');
 fail(()=>verifyLabSignature(secret,Buffer.alloc(0),timestamp,signature),
  'M8_WEBHOOK_INVALID');
 fail(()=>verifyLabSignature(secret,body,'not-a-time',signature),
  'M8_WEBHOOK_TIMESTAMP_INVALID');
});
