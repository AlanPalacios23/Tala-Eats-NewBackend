/**
 * M3 LAB1 — Stripe TEST webhook cryptographic boundary.
 * Raw request bytes only: do not JSON parse/re-serialize before verifying.
 * No network, no Stripe SDK, no LIVE mode and no external routes.
 */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {FinanceError} from './ledger.mjs';

const EVENT=/^evt_[A-Za-z0-9_]{6,150}$/;
const INTENT=/^pi_[A-Za-z0-9_]{6,150}$/;
const HEADER_MAX=2048;
const BODY_MAX=131072;
export const MAX_SKEW_SECONDS=300;
export const sha256=(bytes)=>createHash('sha256').update(bytes).digest('hex');

export function verifySignedTestEvent(rawBody,signatureHeader,secret,{nowSeconds=Math.floor(Date.now()/1000)}={}){
  if(!Buffer.isBuffer(rawBody)||rawBody.length===0||rawBody.length>BODY_MAX)
    throw new FinanceError('WEBHOOK_BODY_INVALID');
  if(typeof secret!=='string'||!/^whsec_[A-Za-z0-9_]{12,256}$/.test(secret))
    throw new FinanceError('WEBHOOK_SECRET_INVALID');
  if(typeof signatureHeader!=='string'||signatureHeader.length>HEADER_MAX)
    throw new FinanceError('WEBHOOK_SIGNATURE_INVALID');
  const fields=signatureHeader.split(',');
  const timestamps=fields.filter(x=>x.startsWith('t='));
  const signatures=fields.filter(x=>x.startsWith('v1='));
  if(timestamps.length!==1||signatures.length<1||signatures.length>5||
     !Number.isSafeInteger(nowSeconds))
    throw new FinanceError('WEBHOOK_SIGNATURE_INVALID');
  const timeLiteral=timestamps[0].slice(2), timestamp=Number(timeLiteral);
  if(!/^[1-9][0-9]{0,12}$/.test(timeLiteral)||!Number.isSafeInteger(timestamp)||
     Math.abs(nowSeconds-timestamp)>MAX_SKEW_SECONDS)
    throw new FinanceError('WEBHOOK_TIMESTAMP_INVALID');
  const expected=createHmac('sha256',secret)
    .update(String(timestamp)).update('.').update(rawBody).digest();
  const good=signatures.some(field=>{
    const value=field.slice(3);
    return /^[a-f0-9]{64}$/i.test(value)&&
      timingSafeEqual(expected,Buffer.from(value,'hex'));
  });
  if(!good)throw new FinanceError('WEBHOOK_SIGNATURE_INVALID');
  let payload;
  try{payload=JSON.parse(rawBody.toString('utf8'));}
  catch{throw new FinanceError('WEBHOOK_BODY_INVALID');}
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||
     payload.livemode!==false||payload.type!=='payment_intent.succeeded'||
     typeof payload.id!=='string'||!EVENT.test(payload.id)||
     !payload.data||typeof payload.data!=='object')
    throw new FinanceError('WEBHOOK_EVENT_UNSUPPORTED');
  const pi=payload.data.object;
  if(!pi||typeof pi!=='object'||pi.object!=='payment_intent'||
     !INTENT.test(pi.id??'')||pi.status!=='succeeded'||
     pi.currency!=='mxn'||!Number.isSafeInteger(pi.amount_received)||
     pi.amount_received<=0||pi.amount_received>1_000_000_000_000||
     pi.amount!==pi.amount_received)
    throw new FinanceError('PAYMENT_INTENT_INVALID');
  return Object.freeze({
    eventId:payload.id,paymentIntentId:pi.id,amountMinor:String(pi.amount_received),
    rawHash:sha256(rawBody)
  });
}
