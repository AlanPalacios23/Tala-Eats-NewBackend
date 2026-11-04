/** M8 mock-provider HTTP adapter. Restricted to lab/loopback,
 * no public checkout, no Stripe client, no real refunds or payouts.
 */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {Pool} from 'pg';
import {PaymentError,uuid,assertKeys,type Actor} from './domain.js';
import {createPayment,requestRefund,readPayment} from './payments.js';
import {ingestLabWebhook} from './webhook.js';
import {StripeTestClient} from './stripe-test-client.js';
import {createStripeTestIntent,sendStripeTestRefund} from './stripe-test-operations.js';
import {ingestStripeTestWebhook} from './stripe-test-webhook.js';
type Config={pool:Pool,webhookSecret:Buffer,
 authenticate:(request:IncomingMessage)=>Promise<Actor|null>,
 stripeTest?:{client:StripeTestClient,webhookSecret:string}};
const MAX_BYTES=8192;
function reply(res:ServerResponse,status:number,value:unknown){
 if(res.headersSent)return;
 const bytes=Buffer.from(JSON.stringify(value));
 res.writeHead(status,{
  'Content-Type':'application/json; charset=utf-8',
  'Content-Length':String(bytes.length),
  'Cache-Control':'private, no-store',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'none'"
 });
 res.end(bytes);
}
async function readRaw(req:IncomingMessage,maxBytes=MAX_BYTES):Promise<Buffer>{
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
  req.headers['content-type']??''))
  throw new PaymentError('M8_CONTENT_TYPE_REQUIRED');
 const len=Number(req.headers['content-length']??0);
 if(!Number.isSafeInteger(len)||len<0||len>maxBytes)
  throw new PaymentError('M8_BODY_TOO_LARGE');
 const pieces:Buffer[]=[];let used=0;
 for await(const x of req){
  const part=Buffer.isBuffer(x)?x:Buffer.from(x);
  used+=part.length;
  if(used>maxBytes)throw new PaymentError('M8_BODY_TOO_LARGE');
  pieces.push(part);
 }
 return Buffer.concat(pieces);
}
async function readBody(req:IncomingMessage,allowed:readonly string[]){
 const raw=await readRaw(req);
 let data:unknown;
 try{data=JSON.parse(raw.toString('utf8'))}catch{
  throw new PaymentError('M8_REQUEST_INVALID');
 }
 assertKeys(data,allowed);
 return data as Record<string,unknown>;
}
export function createPaymentsLabHttpServer(config:Config){
 if(process.env.NODE_ENV==='production'||!config||
    typeof config.authenticate!=='function'||!Buffer.isBuffer(config.webhookSecret)||
    config.webhookSecret.length<32)
  throw new PaymentError('M8_LAB_HTTP_DISABLED');
 const {pool,webhookSecret,authenticate}=config;
 return createServer(async(req,res)=>{
  // Require both ends of the connection to remain on the local host.
  const local=['127.0.0.1','::1','::ffff:127.0.0.1'];
  if(!local.includes(req.socket.localAddress??'')||
     !local.includes(req.socket.remoteAddress??'')){
   reply(res,403,{error:'M8_LOOPBACK_ONLY'});return;
  }
  try{
   const url=new URL(req.url??'/', 'http://127.0.0.1');
   const path=url.pathname.split('/').filter(Boolean);
   const method=req.method??'';
   if(url.pathname==='/v1/payments/health'&&method==='GET'){
    reply(res,200,{module:'payments',status:'lab_ready',
     provider:'simulated_lab',realFunds:false});return;
   }
   if(url.pathname==='/v1/payments/lab-webhook'&&method==='POST'){
    const raw=await readRaw(req);
    const timestamp=req.headers['x-lab-timestamp'],
     signature=req.headers['x-lab-signature'];
    if(typeof timestamp!=='string'||typeof signature!=='string')
      throw new PaymentError('M8_WEBHOOK_SIGNATURE_INVALID');
    reply(res,200,await ingestLabWebhook(pool,webhookSecret,raw,
     timestamp,signature));return;
   }
   if(url.pathname==='/v1/payments/stripe-test-webhook'&&method==='POST'){
    if(!config.stripeTest)throw new PaymentError('M8_STRIPE_TEST_DISABLED');
    const raw=await readRaw(req,65536);
    const sig=req.headers['stripe-signature'];
    if(typeof sig!=='string')
      throw new PaymentError('M8_STRIPE_SIGNATURE_INVALID');
    reply(res,200,await ingestStripeTestWebhook(pool,
      config.stripeTest.webhookSecret,raw,sig));return;
   }
   const actor=await authenticate(req);
   if(!actor)throw new PaymentError('M8_UNAUTHORIZED');
   uuid(actor.actorId);
   if(path[0]!=='v1'||path[1]!=='payments'){
    reply(res,404,{error:'M8_ROUTE_NOT_FOUND'});return;
   }
   const p=path.slice(2);
   if(p.length===0&&method==='POST'){
    const d=await readBody(req,
     ['operationId','orderRef','customerRef','amountCents','currency']);
    reply(res,201,await createPayment(pool,actor,d as never));return;
   }
   if(p.length===2&&p[1]==='stripe-test-intent'&&method==='POST'){
    if(!config.stripeTest)throw new PaymentError('M8_STRIPE_TEST_DISABLED');
    await readBody(req,[]);
    reply(res,200,await createStripeTestIntent(pool,config.stripeTest.client,
      actor,uuid(p[0])));return;
   }
   if(p.length===4&&p[1]==='refunds'&&
      p[3]==='stripe-test-send'&&method==='POST'){
    if(!config.stripeTest)throw new PaymentError('M8_STRIPE_TEST_DISABLED');
    await readBody(req,[]);
    reply(res,200,await sendStripeTestRefund(pool,config.stripeTest.client,
      actor,uuid(p[2]),uuid(p[0])));return;
   }
   if(p.length===1&&method==='GET'){
    reply(res,200,await readPayment(pool,actor,uuid(p[0])));return;
   }
   if(p.length===2&&p[1]==='refunds'&&method==='POST'){
    const d=await readBody(req,['operationId','amountCents']);
    reply(res,201,await requestRefund(pool,actor,{
     ...d,paymentId:uuid(p[0])
    } as never));return;
   }
   reply(res,404,{error:'M8_ROUTE_NOT_FOUND'});
  }catch(e){
   if(e instanceof PaymentError){
    const status=e.code==='M8_UNAUTHORIZED'||e.code.startsWith('M8_WEBHOOK_SIGNATURE')||
      e.code==='M8_WEBHOOK_TIMESTAMP_INVALID'?401:
     e.code==='M8_FORBIDDEN'?403:
     e.code==='M8_CONTENT_TYPE_REQUIRED'?415:
     e.code==='M8_BODY_TOO_LARGE'?413:
     e.code==='M8_PAYMENT_NOT_FOUND'||e.code==='M8_REFUND_NOT_FOUND'?404:
     e.code==='M8_STRIPE_TEST_DISABLED'?503:
     e.code==='M8_STRIPE_SIGNATURE_INVALID'||e.code==='M8_STRIPE_LIVEMODE_FORBIDDEN'?401:
     e.code==='M8_STRIPE_NETWORK_UNCERTAIN'||
      e.code==='M8_STRIPE_RECONCILIATION_REQUIRED'||
      e.code==='M8_STRIPE_UNBOUND_EVENT'?503:
     ['M8_IDEMPOTENCY_CONFLICT','M8_ORDER_PAYMENT_EXISTS',
      'M8_PAYMENT_NOT_SETTLED','M8_REFUND_EXCEEDS_PAYMENT',
      'M8_WEBHOOK_REPLAY_CONFLICT','M8_EVENT_STATE_CONFLICT',
      'M8_WEBHOOK_AMOUNT_MISMATCH','M8_PROVIDER_REFERENCE_CONFLICT',
      'M8_STRIPE_OPERATION_IN_PROGRESS','M8_STRIPE_EVENT_REPLAY_CONFLICT',
      'M8_STRIPE_AMOUNT_MISMATCH','M8_PAYMENT_PROVIDER_CONFLICT']
       .includes(e.code)?409:400;
    reply(res,status,{error:e.code});return;
   }
   reply(res,500,{error:'M8_INTERNAL_ERROR'});
  }
 });
}
