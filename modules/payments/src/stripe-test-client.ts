/** M8 Stripe TEST-only PaymentIntents/Refunds adapter.
 * No LIVE credentials, Connect, transfers, captures, customer cards or payouts.
 * Network is injectable for completely offline contract testing.
 */
import {PaymentError,amount,uuid} from './domain.js';

const API='https://api.stripe.com';
const VERSION='2026-10-28.endive';
const PI=/^pi_[A-Za-z0-9]{4,128}$/;
const REFUND=/^re_[A-Za-z0-9]{4,128}$/;
export type StripeTestPaymentIntent={
 id:string,object:'payment_intent',livemode:false,
 amount:number,currency:'mxn',status:string,
 metadata:Record<string,string>,client_secret:string|null
};
export type StripeTestRefund={
 id:string,object:'refund',livemode:false,amount:number,currency:'mxn',
 status:string|null,payment_intent:string|null,metadata:Record<string,string>
};
export type StripeTransport=typeof fetch;

function obj(raw:unknown):Record<string,unknown>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))
  throw new PaymentError('M8_STRIPE_RESPONSE_INVALID');
 return raw as Record<string,unknown>;
}
function metadata(value:unknown):Record<string,string>{
 const m=obj(value);
 if(Object.values(m).some(v=>typeof v!=='string'))
  throw new PaymentError('M8_STRIPE_RESPONSE_INVALID');
 return m as Record<string,string>;
}
function validateIntent(raw:unknown,expected:{paymentId:string,amountCents:number}):
 StripeTestPaymentIntent{
 const p=obj(raw),meta=metadata(p.metadata);
 if(p.object!=='payment_intent'||p.livemode!==false||
    typeof p.id!=='string'||!PI.test(p.id)||
    p.amount!==expected.amountCents||p.currency!=='mxn'||
    meta.m8_payment_id!==expected.paymentId||typeof p.status!=='string'||
    !(p.client_secret===null||typeof p.client_secret==='string'))
   throw new PaymentError('M8_STRIPE_RESPONSE_INVALID');
 if(!['requires_payment_method','requires_confirmation','requires_action',
       'processing','requires_capture','succeeded','canceled'].includes(p.status))
   throw new PaymentError('M8_STRIPE_RESPONSE_INVALID');
 return Object.freeze({id:p.id,object:'payment_intent',livemode:false,
   amount:p.amount as number,currency:'mxn',status:p.status,
   metadata:meta,client_secret:p.client_secret as string|null});
}
function validateRefund(raw:unknown,expected:{
 refundId:string,intentId:string,amountCents:number
}):StripeTestRefund{
 const r=obj(raw),meta=metadata(r.metadata);
 if(r.object!=='refund'||r.livemode!==false||typeof r.id!=='string'||
    !REFUND.test(r.id)||r.amount!==expected.amountCents||r.currency!=='mxn'||
    r.payment_intent!==expected.intentId||
    meta.m8_refund_id!==expected.refundId||
    !(r.status===null||typeof r.status==='string'))
   throw new PaymentError('M8_STRIPE_RESPONSE_INVALID');
 return Object.freeze({id:r.id,object:'refund',livemode:false,
  amount:r.amount as number,currency:'mxn',status:r.status as string|null,
  payment_intent:expected.intentId,metadata:meta});
}
export class StripeTestClient{
 private readonly key:string;
 private readonly transport:StripeTransport;
 constructor(opts:{apiKey:string,transport?:StripeTransport}){
  if(!opts||typeof opts.apiKey!=='string'||
    !/^sk_test_[A-Za-z0-9_]{12,}$/.test(opts.apiKey))
    throw new PaymentError('M8_STRIPE_TEST_KEY_REQUIRED');
  this.key=opts.apiKey;
  this.transport=opts.transport??fetch;
 }
 private async request(method:'POST'|'GET',path:string,
  key?:string,params?:URLSearchParams):Promise<unknown>{
  // No redirects or caller-supplied domains. No real cards.
  let response:Response;
  try{
   response=await this.transport(API+path,{
    method,headers:{
     'Authorization':'Bearer '+this.key,
     'Stripe-Version':VERSION,
     ...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{}),
     ...(key?{'Idempotency-Key':key}:{})
    },body:params?.toString(),redirect:'error',
    signal:AbortSignal.timeout(8000)
   });
  }catch{throw new PaymentError('M8_STRIPE_NETWORK_UNCERTAIN');}
  if(response.status===429||response.status>=500)
   throw new PaymentError('M8_STRIPE_NETWORK_UNCERTAIN');
  if(!response.ok)
   throw new PaymentError('M8_STRIPE_REQUEST_REJECTED');
  let body:string;
  try{body=await response.text();}catch{
   throw new PaymentError('M8_STRIPE_NETWORK_UNCERTAIN');
  }
  if(body.length>65536)
   throw new PaymentError('M8_STRIPE_RESPONSE_INVALID');
  try{return JSON.parse(body) as unknown;}catch{
   throw new PaymentError('M8_STRIPE_RESPONSE_INVALID');
  }
 }
 async createIntent(input:{paymentId:string,amountCents:number,
  idempotencyKey:string}){
  const paymentId=uuid(input.paymentId),cents=amount(input.amountCents);
  if(input.idempotencyKey!=='m8-pi-'+paymentId)
   throw new PaymentError('M8_STRIPE_KEY_INVALID');
  const p=new URLSearchParams({
   amount:String(cents),currency:'mxn',
   'payment_method_types[]':'card',
   'metadata[m8_payment_id]':paymentId
  });
  return validateIntent(await this.request('POST','/v1/payment_intents',
   input.idempotencyKey,p),{paymentId,amountCents:cents});
 }
 async retrieveIntent(input:{intentId:string,paymentId:string,amountCents:number}){
  const paymentId=uuid(input.paymentId),cents=amount(input.amountCents);
  if(!PI.test(input.intentId))throw new PaymentError('M8_STRIPE_ID_INVALID');
  return validateIntent(await this.request('GET','/v1/payment_intents/'+
   encodeURIComponent(input.intentId)),{paymentId,amountCents:cents});
 }
 async createRefund(input:{refundId:string,intentId:string,
  amountCents:number,idempotencyKey:string}){
  const refundId=uuid(input.refundId),cents=amount(input.amountCents);
  if(!PI.test(input.intentId)||input.idempotencyKey!=='m8-re-'+refundId)
   throw new PaymentError('M8_STRIPE_KEY_INVALID');
  const p=new URLSearchParams({
   payment_intent:input.intentId,amount:String(cents),
   'metadata[m8_refund_id]':refundId
  });
  return validateRefund(await this.request('POST','/v1/refunds',
   input.idempotencyKey,p),{refundId,intentId:input.intentId,amountCents:cents});
 }
}
