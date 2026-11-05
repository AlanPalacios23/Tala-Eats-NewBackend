import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {AnalyticsError,EVENT_ISSUERS,signAnalyticsEvent,verifySignedEvent,
 validEvent,type AnalyticsEvent,type IssuerKeys,type Issuer} from '../src/contract.js';

const keys:IssuerKeys={
 orders:{ops01:randomBytes(32)},
 payments:{ops01:randomBytes(32)},
 logistics:{ops01:randomBytes(32)}
};
const id=()=>randomUUID();
const at=()=>new Date(Math.floor(Date.now()/1000)*1000).toISOString().replace('.000Z','Z');
function sample(part:Partial<AnalyticsEvent>={}):AnalyticsEvent{
 return {eventId:id(),kind:'order.completed',merchantId:id(),orderId:id(),
  refundId:null,amountCents:49900,occurredAt:at(),...part};
}
const fail=(fn:()=>unknown,code:string)=>assert.throws(fn,
 e=>e instanceof AnalyticsError&&e.code===code);

test('M10 has a closed issuer map and enforces exact private-free schema',()=>{
 assert.deepEqual(Object.keys(EVENT_ISSUERS).sort(),
  ['delivery.completed','order.canceled','order.completed',
   'payment.confirmed','refund.confirmed']);
 assert.equal(validEvent(sample()).amountCents,49900);
 fail(()=>validEvent({...sample(),customerEmail:'user@example.com'}),
  'M10_EVENT_INVALID');
 fail(()=>validEvent({...sample(),address:'sensitive'}),
  'M10_EVENT_INVALID');
 fail(()=>validEvent({...sample(),amountCents:499.4}),
  'M10_EVENT_INVALID');
 fail(()=>validEvent({...sample(),kind:'order.canceled',amountCents:500}),
  'M10_EVENT_INVALID');
 fail(()=>validEvent({...sample(),kind:'refund.confirmed',refundId:null}),
  'M10_EVENT_INVALID');
 fail(()=>validEvent({...sample(),kind:'payment.confirmed',refundId:id()}),
  'M10_EVENT_INVALID');
 fail(()=>validEvent({...sample(),occurredAt:'2026-02-30T12:00:00Z'}),
  'M10_EVENT_TIME_INVALID');
 fail(()=>validEvent({...sample(),occurredAt:'2000-01-01T00:00:00Z'}),
  'M10_EVENT_OUT_OF_WINDOW');
 fail(()=>validEvent({...sample(),occurredAt:
   new Date(Date.now()+3600000).toISOString().replace(/\.\d{3}Z$/,'Z')}),
  'M10_EVENT_OUT_OF_WINDOW');
});
test('M10 verifies per-issuer HMAC over original raw bytes, key ID and timestamp',()=>{
 const body=Buffer.from(JSON.stringify(sample()));
 const signature=signAnalyticsEvent(body,'orders','ops01',keys);
 const ok=verifySignedEvent(body,'orders','ops01',signature,keys);
 assert.equal(ok.event.kind,'order.completed');
 assert.match(ok.hash,/^[a-f0-9]{64}$/);
 fail(()=>verifySignedEvent(Buffer.from(body.toString().replace('49900','49901')),
  'orders','ops01',signature,keys),'M10_SIGNATURE_INVALID');
 fail(()=>verifySignedEvent(body,'payments','ops01',signature,keys),
  'M10_SIGNATURE_INVALID');
 fail(()=>verifySignedEvent(body,'orders','wrong1',signature,keys),
  'M10_ISSUER_UNTRUSTED');
 fail(()=>verifySignedEvent(body,'orders','ops01',
  't=0000000000,v1='+('0'.repeat(64)),keys),'M10_SIGNATURE_EXPIRED');
 fail(()=>verifySignedEvent(body,'orders','ops01',signature+',v1=x',keys),
  'M10_SIGNATURE_INVALID');
 const tampered=Buffer.from(JSON.stringify(sample({kind:'payment.confirmed'})));
 fail(()=>verifySignedEvent(tampered,'orders','ops01',
  signAnalyticsEvent(tampered,'orders','ops01',keys),keys),
  'M10_ISSUER_SCOPE_INVALID');
});
test('M10 accepts MXN cents only as safe integers and rejects invalid issuer keys',()=>{
 fail(()=>validEvent(sample({amountCents:Number.MAX_SAFE_INTEGER})),
  'M10_EVENT_INVALID');
 fail(()=>signAnalyticsEvent(Buffer.from('{}'),'orders','ops01',{
  ...keys,orders:{ops01:randomBytes(8)}
 }), 'M10_KEY_INVALID');
 const refund=validEvent(sample({kind:'refund.confirmed',refundId:id(),
  amountCents:1000}));
 assert.equal(refund.kind,'refund.confirmed');
});
