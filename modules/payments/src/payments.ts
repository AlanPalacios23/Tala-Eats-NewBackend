/** M8 independent LAB payment intents and refund requests.
 * Creates provider-agnostic intent records, never charges a card.
 * No orders/finance/driver imports and no integration with a live gateway.
 */
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {PaymentError,requireActor,uuid,amount,currency,digest,type Actor} from './domain.js';
import {tx,claim,complete,audit} from './db.js';

export async function createPayment(pool:Pool,actor:Actor,input:{
 operationId:string,orderRef:string,customerRef:string,
 amountCents:number,currency:'MXN'
}){
 const operator=requireActor(actor,'canCreatePayments'),
  op=uuid(input.operationId),order=uuid(input.orderRef),
  customer=uuid(input.customerRef),money=amount(input.amountCents),
  unit=currency(input.currency),fingerprint=digest({order,customer,money,unit});
 return tx(pool,async c=>{
  const prior=await claim(c,operator,op,'payment.create',fingerprint);
  if(prior){
   const current=await c.query<{state:string}>(
    'SELECT state FROM tala_payments_v2.payments WHERE id=$1::uuid',[prior]);
   if(!current.rows[0])throw new PaymentError('M8_IDEMPOTENCY_CONFLICT');
   return Object.freeze({id:prior,replayed:true,state:current.rows[0].state});
  }
  const id=randomUUID();
  try{
   await c.query('INSERT INTO tala_payments_v2.payments '+
    '(id,order_ref,customer_ref,amount_cents,currency) '+
    'VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5)',
    [id,order,customer,money,unit]);
  }catch(e){
   if((e as {code?:string}).code==='23505')
    throw new PaymentError('M8_ORDER_PAYMENT_EXISTS');
   throw e;
  }
  await audit(c,operator,'payment.create',id);
  await complete(c,operator,op,id);
  return Object.freeze({id,replayed:false,state:'pending' as const});
 });
}
export async function requestRefund(pool:Pool,actor:Actor,input:{
 operationId:string,paymentId:string,amountCents:number
}){
 const operator=requireActor(actor,'canRefundPayments'),
  op=uuid(input.operationId),payment=uuid(input.paymentId),
  money=amount(input.amountCents);
 const fingerprint=digest({payment,money});
 return tx(pool,async c=>{
  const prior=await claim(c,operator,op,'refund.request',fingerprint);
  if(prior){
   const current=await c.query<{state:string}>(
    'SELECT state FROM tala_payments_v2.refunds WHERE id=$1::uuid',[prior]);
   if(!current.rows[0])throw new PaymentError('M8_IDEMPOTENCY_CONFLICT');
   return Object.freeze({id:prior,replayed:true,state:current.rows[0].state});
  }
  const p=await c.query<{amount_cents:string,state:string}>(
   'SELECT amount_cents,state FROM tala_payments_v2.payments '+
   'WHERE id=$1::uuid FOR UPDATE',[payment]);
  if(!p.rows[0]||p.rows[0].state!=='succeeded')
   throw new PaymentError('M8_PAYMENT_NOT_SETTLED');
  const r=await c.query<{reserved:string}>(
   'SELECT coalesce(sum(amount_cents),0)::text AS reserved '+
   'FROM tala_payments_v2.refunds WHERE payment_id=$1::uuid '+
   "AND state IN ('requested','succeeded')",[payment]);
  const available=Number(p.rows[0].amount_cents)-Number(r.rows[0]!.reserved);
  if(money>available)throw new PaymentError('M8_REFUND_EXCEEDS_PAYMENT');
  const id=randomUUID();
  await c.query('INSERT INTO tala_payments_v2.refunds '+
   '(id,payment_id,amount_cents) VALUES($1::uuid,$2::uuid,$3)',
   [id,payment,money]);
  await audit(c,operator,'refund.request',id);
  await complete(c,operator,op,id);
  return Object.freeze({id,replayed:false,state:'requested' as const});
 });
}

export async function readPayment(pool:Pool,actor:Actor,paymentId:string){
 requireActor(actor,'canReadPayments');
 const id=uuid(paymentId);
 return tx(pool,async c=>{
  const p=await c.query<{
   id:string,order_ref:string,customer_ref:string,amount_cents:string,
   currency:string,state:string,version:number,provider:string,
   provider_ref:string|null
  }>('SELECT id,order_ref,customer_ref,amount_cents,currency,state,'+
   'version,provider,provider_ref FROM tala_payments_v2.payments WHERE id=$1::uuid',[id]);
  if(!p.rows[0])throw new PaymentError('M8_PAYMENT_NOT_FOUND');
  const refunds=await c.query<{id:string,amount_cents:string,state:string,version:number}>(
   'SELECT id,amount_cents,state,version FROM tala_payments_v2.refunds '+
   'WHERE payment_id=$1::uuid ORDER BY created_at,id',[id]);
  const facts=await c.query<{
   fact_type:string,amount_cents:string,currency:string,source:string,
   event_id:string,refund_id:string|null
  }>('SELECT fact_type,amount_cents,currency,source,event_id,refund_id '+
   'FROM tala_payments_v2.verified_facts WHERE payment_id=$1::uuid '+
   'ORDER BY created_at,id',[id]);
  const stripeTest=await c.query<{
   stripe_event_id:string,fact_type:string,refund_id:string|null,
   amount_cents:string,currency:string,source:string
  }>('SELECT stripe_event_id,fact_type,refund_id,'+
   'amount_cents::text,currency,source FROM tala_payments_v2.stripe_test_facts '+
   'WHERE payment_id=$1::uuid ORDER BY created_at,stripe_event_id',[id]);
  const row=p.rows[0];
  return Object.freeze({
   id:row.id,orderRef:row.order_ref,customerRef:row.customer_ref,
   amountCents:Number(row.amount_cents),currency:row.currency,
   state:row.state,version:row.version,provider:row.provider,
   providerRef:row.provider_ref,
   refunds:Object.freeze(refunds.rows.map(x=>Object.freeze({
    id:x.id,amountCents:Number(x.amount_cents),state:x.state,
    version:x.version
   }))),
   facts:Object.freeze(facts.rows.map(x=>Object.freeze({
    type:x.fact_type,amountCents:Number(x.amount_cents),
    currency:x.currency,source:x.source,eventId:x.event_id,
    refundId:x.refund_id
   }))),
   // TEST events deliberately separated from simulated LAB facts and M3.
   stripeTestFacts:Object.freeze(stripeTest.rows.map(x=>Object.freeze({
    type:x.fact_type,amountCents:Number(x.amount_cents),
    currency:x.currency,source:x.source,
    eventId:x.stripe_event_id,refundId:x.refund_id
   })))
  });
 },true);
}
