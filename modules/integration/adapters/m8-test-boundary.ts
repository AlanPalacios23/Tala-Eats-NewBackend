/** Strict M11 boundary for the REAL M8 TEST implementation.
 * Native dynamic imports use fixed internal file URLs, never user input.
 * M8's original compiler settings differ from M4's. Isolating its
 * implementation avoids weakening M11's strict compiler policy.
 * This is a LAB adapter, NOT a substitute implementation of M8.
 */
import type {Pool} from 'pg';
type Actor={actorId:string,canCreatePayments?:boolean,
 canReadPayments?:boolean,canReadAllPayments?:boolean};
export type M8TestClient={
 createIntent:(input:{paymentId:string,amountCents:number,
  idempotencyKey:string})=>Promise<unknown>,
 retrieveIntent:(input:{intentId:string,paymentId:string,
  amountCents:number})=>Promise<unknown>,
 createRefund:(input:{refundId:string,intentId:string,
  amountCents:number,idempotencyKey:string})=>Promise<unknown>
};
export type M8PaymentSummary={id:string,replayed:boolean,state:string};
export type M8IntentSummary={paymentId:string,intentId:string,
 clientSecret:string|null,status:string,livemode:false,provider:'stripe_test'};
export type M8ReadPayment={
 id:string,orderRef:string,customerRef:string,amountCents:number,
 currency:string,state:string,provider:string,
 stripeTestFacts:Array<{
  type:string,amountCents:number,currency:string,source:string,
  eventId:string,refundId:string|null
 }>
};
export type M8WebhookOutcome={
 ignored?:boolean,replayed?:boolean,applied:boolean,eventId?:string
};
async function m8<T>(source:'payments'|'stripe-test-client'|
 'stripe-test-operations'|'stripe-test-webhook'):Promise<T>{
 const url=new URL('../../payments/src/'+source+'.ts',import.meta.url);
 // Dynamic URL is intentionally constant and not accessible to a caller.
 return await import(url.href) as T;
}
export async function createM8StripeTestClient(
 options:{apiKey:string,transport?:typeof fetch}):Promise<M8TestClient>{
 const source=await m8<{StripeTestClient:
  new (options:{apiKey:string,transport?:typeof fetch})=>M8TestClient}>(
  'stripe-test-client');
 return new source.StripeTestClient(options);
}
type M8PaymentInput={operationId:string,orderRef:string,
 customerRef:string,amountCents:number,currency:'MXN'};
export async function createM8TestPayment(pool:Pool,actor:Actor,
 input:M8PaymentInput):Promise<M8PaymentSummary>{
 const source=await m8<{createPayment:(pool:Pool,actor:Actor,input:M8PaymentInput)=>
  Promise<M8PaymentSummary>}>('payments');
 return source.createPayment(pool,actor,input);
}
export async function readM8TestPayment(pool:Pool,actor:Actor,id:string):
 Promise<M8ReadPayment>{
 const source=await m8<{readPayment:(pool:Pool,actor:Actor,id:string)=>
  Promise<M8ReadPayment>}>('payments');
 return source.readPayment(pool,actor,id);
}
export async function issueM8TestIntent(pool:Pool,client:M8TestClient,
 actor:Actor,id:string):Promise<M8IntentSummary>{
 const source=await m8<{createStripeTestIntent:(pool:Pool,
  client:M8TestClient,actor:Actor,id:string)=>Promise<M8IntentSummary>}>(
  'stripe-test-operations');
 return source.createStripeTestIntent(pool,client,actor,id);
}
export async function ingestM8StripeTestWebhook(pool:Pool,secret:string,
 raw:Buffer,signature:string):Promise<M8WebhookOutcome>{
 const source=await m8<{ingestStripeTestWebhook:(pool:Pool,
  secret:string,raw:Buffer,signature:string)=>Promise<M8WebhookOutcome>}>(
  'stripe-test-webhook');
 return source.ingestStripeTestWebhook(pool,secret,raw,signature);
}
