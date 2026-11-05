import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import pg from 'pg';
import {createPayment,requestRefund,readPayment} from '../src/payments.js';
import {ingestLabWebhook} from '../src/webhook.js';

const url=process.env.PAYMENTS_CI_URL??'';
const enabled=/\/tala_payments_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
const signer=randomBytes(32);
const actor={actorId:id(),canCreatePayments:true,
 canReadPayments:true,canReadAllPayments:true,canRefundPayments:true};
function signed(event:unknown){
 const raw=Buffer.from(JSON.stringify(event));
 const timestamp=String(Math.floor(Date.now()/1000));
 const signature='v1='+createHmac('sha256',signer).update(timestamp)
  .update('.').update(raw).digest('hex');
 return {raw,timestamp,signature};
}
async function settled(pool:pg.Pool,value=10000){
 const payment=await createPayment(pool,actor,{operationId:id(),orderRef:id(),
  customerRef:id(),amountCents:value,currency:'MXN'});
 const event=signed({eventId:id(),kind:'payment.succeeded',
  paymentId:payment.id,amountCents:value,currency:'MXN',
  providerRef:'lab_'+randomBytes(12).toString('hex')});
 await ingestLabWebhook(pool,signer,event.raw,event.timestamp,event.signature);
 return payment.id;
}
const sqlReject=async(p:Promise<unknown>,fragment:string)=>
 assert.rejects(p,e=>e instanceof Error&&e.message.includes(fragment));

test('M8 LAB3 SQL guards immutable amount/currency/reference and terminal payment',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:9});
 try{
  const initial=await createPayment(pool,actor,{operationId:id(),
   orderRef:id(),customerRef:id(),amountCents:15000,currency:'MXN'});
  await sqlReject(pool.query('UPDATE tala_payments_v2.payments '+
   'SET amount_cents=10,version=version+1 WHERE id=$1::uuid',[initial.id]),
   'M8_PAYMENT_CORE_IMMUTABLE');
  await sqlReject(pool.query('UPDATE tala_payments_v2.payments '+
   "SET state='succeeded' WHERE id=$1::uuid",[initial.id]),
   'M8_PAYMENT_VERSION_INVALID');
  await sqlReject(pool.query('INSERT INTO tala_payments_v2.payments '+
   '(order_ref,customer_ref,amount_cents,state) '+
   "VALUES($1::uuid,$2::uuid,1200,'succeeded')",[id(),id()]),
   'M8_PAYMENT_INITIAL_STATE_INVALID');
  const paid=await settled(pool);
  await sqlReject(pool.query('UPDATE tala_payments_v2.payments '+
   "SET state='failed',version=version+1 WHERE id=$1::uuid",[paid]),
   'M8_PAYMENT_TERMINAL_IMMUTABLE');
  await sqlReject(pool.query('UPDATE tala_payments_v2.payments '+
   "SET provider_ref='lab_changed_123456',version=version+1 "+
   'WHERE id=$1::uuid',[paid]),
   'M8_PAYMENT_PROVIDER_REFERENCE_IMMUTABLE');
  const read=await readPayment(pool,actor,paid);
  assert.equal(read.state,'succeeded');
 }finally{await pool.end();}
});

test('M8 LAB3 SQL prohibits direct over-refund including simultaneous raw SQL writes',
 {skip:!enabled,timeout:90000},async()=>{
 const pool=new pg.Pool({connectionString:url,max:12});
 try{
  const paymentId=await settled(pool,10000);
  const unauthorized=pool.query(
   'INSERT INTO tala_payments_v2.refunds(payment_id,amount_cents) '+
   "VALUES($1::uuid,10001)",[paymentId]);
  await sqlReject(unauthorized,'M8_REFUND_EXCEEDS_PAYMENT');
  const attempts=await Promise.allSettled(Array.from({length:4},()=>
   pool.query<{id:string}>(
    'INSERT INTO tala_payments_v2.refunds(payment_id,amount_cents) '+
    'VALUES($1::uuid,7000) RETURNING id',[paymentId])));
  const success=attempts.filter(x=>x.status==='fulfilled');
  const failures=attempts.filter(x=>x.status==='rejected');
  assert.equal(success.length,1);
  assert.equal(failures.length,3);
  assert.ok(failures.every(x=>x.status==='rejected'&&
   String(x.reason).includes('M8_REFUND_EXCEEDS_PAYMENT')));
  const refundId=(success[0] as
   PromiseFulfilledResult<pg.QueryResult<{id:string}>>).value.rows[0]!.id;
  await sqlReject(pool.query('UPDATE tala_payments_v2.refunds '+
   'SET amount_cents=9000,version=version+1 WHERE id=$1::uuid',[refundId]),
   'M8_REFUND_CORE_IMMUTABLE');
  await sqlReject(pool.query('UPDATE tala_payments_v2.refunds '+
   "SET state='failed' WHERE id=$1::uuid",[refundId]),
   'M8_REFUND_VERSION_INVALID');
  const rest=await requestRefund(pool,actor,{operationId:id(),
   paymentId,amountCents:3000});
  assert.equal(rest.state,'requested');
  const state=await readPayment(pool,actor,paymentId);
  assert.equal(state.refunds.reduce((a,x)=>a+
   (x.state==='requested'||x.state==='succeeded'?x.amountCents:0),0),10000);
  await sqlReject(pool.query('INSERT INTO tala_payments_v2.refunds '+
   "(payment_id,amount_cents,state) VALUES($1::uuid,100,'succeeded')",
   [paymentId]),'M8_REFUND_INITIAL_STATE_INVALID');
 }finally{await pool.end();}
});
