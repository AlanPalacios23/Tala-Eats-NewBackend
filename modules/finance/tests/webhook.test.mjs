import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {FinanceError} from '../src/ledger.mjs';
import {verifySignedTestEvent} from '../src/stripe-test-webhook.mjs';

const secret='whsec_unit_test_key_0123456789abcdef';
const at=Math.floor(Date.now()/1000);
const build=()=>({
  id:'evt_lab_1234567890',object:'event',livemode:false,type:'payment_intent.succeeded',
  data:{object:{id:'pi_lab_1234567890',object:'payment_intent',livemode:false,
    status:'succeeded',amount:30650,amount_received:30650,currency:'mxn'}}
});
const sign=(raw,t=at,key=secret)=>'t='+t+',v1='+
  createHmac('sha256',key).update(String(t)).update('.').update(raw).digest('hex');
const rejected=(fn,code)=>assert.throws(fn,e=>e instanceof FinanceError&&e.code===code);

test('verifies raw TEST signature without changing signed bytes',()=>{
  const raw=Buffer.from(JSON.stringify(build()));
  const receipt=verifySignedTestEvent(raw,sign(raw),secret,{nowSeconds:at});
  assert.equal(receipt.eventId,'evt_lab_1234567890');
  assert.equal(receipt.paymentIntentId,'pi_lab_1234567890');
  assert.equal(receipt.amountMinor,'30650');
  assert.match(receipt.rawHash,/^[a-f0-9]{64}$/);
});
test('rejects changed bytes, wrong secret, missing signature and string body',()=>{
  const raw=Buffer.from(JSON.stringify(build()));
  rejected(()=>verifySignedTestEvent(Buffer.from(raw.toString().replace('30650','30651')),
    sign(raw),secret,{nowSeconds:at}),'WEBHOOK_SIGNATURE_INVALID');
  rejected(()=>verifySignedTestEvent(raw,sign(raw,at,'whsec_wrong_key_0123456789abcdef'),
    secret,{nowSeconds:at}),'WEBHOOK_SIGNATURE_INVALID');
  rejected(()=>verifySignedTestEvent(raw,'t='+at,secret,{nowSeconds:at}),
    'WEBHOOK_SIGNATURE_INVALID');
  rejected(()=>verifySignedTestEvent(raw.toString(),sign(raw),secret,{nowSeconds:at}),
    'WEBHOOK_BODY_INVALID');
});
test('rejects stale and future timestamps even with valid HMAC',()=>{
  const raw=Buffer.from(JSON.stringify(build()));
  for(const t of [at-301,at+301]){
    rejected(()=>verifySignedTestEvent(raw,sign(raw,t),secret,{nowSeconds:at}),
      'WEBHOOK_TIMESTAMP_INVALID');
  }
});
test('rejects live, unauthorized event type, and unpaid statuses after HMAC',()=>{
  const bad=[
    {...build(),livemode:true},
    {...build(),type:'payment_intent.created'},
    {...build(),data:{object:{...build().data.object,status:'requires_capture'}}},
    {...build(),data:{object:{...build().data.object,amount_received:0}}}
  ];
  for(let i=0;i<bad.length;i++){
    const raw=Buffer.from(JSON.stringify(bad[i]));
    rejected(()=>verifySignedTestEvent(raw,sign(raw),secret,{nowSeconds:at}),
      i<2?'WEBHOOK_EVENT_UNSUPPORTED':'PAYMENT_INTENT_INVALID');
  }
});
test('rejects non-MXN payments and partial capture',()=>{
  for(const o of [{currency:'usd'},{amount_received:26000}]){
    const data=build();Object.assign(data.data.object,o);
    const raw=Buffer.from(JSON.stringify(data));
    rejected(()=>verifySignedTestEvent(raw,sign(raw),secret,{nowSeconds:at}),
      'PAYMENT_INTENT_INVALID');
  }
});
