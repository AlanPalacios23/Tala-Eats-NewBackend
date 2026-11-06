/** M4 internal TOTP RFC 6238 — never exposed as a raw API secret. */
import {createCipheriv,createDecipheriv,createHmac,
  randomBytes,timingSafeEqual} from 'node:crypto';
import {UsersError} from './domain.js';
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function encodeBase32(value:Buffer):string{
  let bits=0,buffer=0,result='';
  for(const v of value){
    buffer=(buffer<<8)|v;bits+=8;
    while(bits>=5){result+=ALPHABET[(buffer>>>(bits-=5))&31];}
  }
  if(bits>0)result+=ALPHABET[(buffer<<(5-bits))&31];
  return result;
}
export function decodeBase32(value:string):Buffer{
  if(!/^[A-Z2-7]{32}$/.test(value))
    throw new UsersError('USERS_TOTP_INVALID');
  let bits=0,buffer=0;const bytes:number[]=[];
  for(const char of value){
    const v=ALPHABET.indexOf(char);
    buffer=(buffer<<5)|v;bits+=5;
    if(bits>=8){bytes.push((buffer>>>(bits-=8))&255);}
  }
  if(bytes.length!==20)throw new UsersError('USERS_TOTP_INVALID');
  return Buffer.from(bytes);
}
export function newTotpSecret():string{return encodeBase32(randomBytes(20));}
function key(secret:Buffer){
  if(!Buffer.isBuffer(secret)||secret.length<32)
    throw new UsersError('USERS_TOTP_CONFIG_INVALID');
  return createHmac('sha256',secret)
    .update('tala.users.totp.encryption.v1').digest();
}
export function sealTotp(accountId:string,value:string,secret:Buffer){
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key(secret),iv);
  cipher.setAAD(Buffer.from(accountId));
  const plaintext=decodeBase32(value);
  const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  plaintext.fill(0);
  return {iv:iv.toString('hex'),cipher:encrypted.toString('hex'),
    tag:cipher.getAuthTag().toString('hex')};
}
export function unsealTotp(accountId:string,row:{
  secret_iv_hex:string,secret_cipher_hex:string,secret_tag_hex:string
},secret:Buffer){
  try{
    const dec=createDecipheriv('aes-256-gcm',key(secret),
      Buffer.from(row.secret_iv_hex,'hex'));
    dec.setAAD(Buffer.from(accountId));
    dec.setAuthTag(Buffer.from(row.secret_tag_hex,'hex'));
    const value=Buffer.concat([
      dec.update(Buffer.from(row.secret_cipher_hex,'hex')),dec.final()]);
    try{return encodeBase32(value);}
    finally{value.fill(0);}
  }catch{throw new UsersError('USERS_TOTP_CONFIG_INVALID');}
}
export function totpCode(secret:string,counter:number):string{
  if(!Number.isSafeInteger(counter)||counter<0)
    throw new UsersError('USERS_TOTP_INVALID');
  const value=decodeBase32(secret),frame=Buffer.alloc(8);
  frame.writeBigUInt64BE(BigInt(counter));
  const digest=createHmac('sha1',value).update(frame).digest();
  value.fill(0);
  const offset=digest[digest.length-1]!&0xf;
  const integer=(digest.readUInt32BE(offset)&0x7fffffff)%1_000_000;
  digest.fill(0);
  return integer.toString().padStart(6,'0');
}
/** Accept ±1 30s time windows; monotonic counter forbids replays. */
export function matchTotp(secret:string,candidate:string,
  lastCounter:bigint,now=Date.now()):bigint|null{
  if(typeof candidate!=='string'||!/^\d{6}$/.test(candidate))
    return null;
  const current=Math.floor(now/30_000);
  for(const frame of [current-1,current,current+1]){
    if(frame<0||BigInt(frame)<=lastCounter)continue;
    const expected=Buffer.from(totpCode(secret,frame));
    const actual=Buffer.from(candidate);
    if(timingSafeEqual(expected,actual))return BigInt(frame);
  }
  return null;
}
