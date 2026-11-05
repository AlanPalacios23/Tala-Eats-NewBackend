/** Device tokens encrypted at rest, scoped cryptographically to account/app.
 * The secret is application-owned, never placed in SQL or the repo.
 */
import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
import {NotificationError,uuid,appValue,type App} from './domain.js';
export type Platform='android'|'ios'|'web';
export const platformValue=(v:unknown):Platform=>{
  if(v!=='android'&&v!=='ios'&&v!=='web')
    throw new NotificationError('NOTIFICATIONS_PLATFORM_INVALID');
  return v;
};
export function requireSecret(secret:unknown){
  if(!Buffer.isBuffer(secret)||secret.length<32)
    throw new NotificationError('NOTIFICATIONS_SECRET_INVALID');
  return secret;
}
function derived(secret:Buffer,label:string){
  return createHmac('sha256',secret)
    .update('tala.notifications.v1|'+label).digest();
}
export function validateDeviceToken(v:unknown){
  if(typeof v!=='string'||v.length<20||v.length>4096||
     !/^[a-zA-Z0-9._~:/-]+$/.test(v))
    throw new NotificationError('NOTIFICATIONS_DEVICE_TOKEN_INVALID');
  return v;
}
export function sealDeviceToken(input:{
  token:string,recipientId:string,app:App,platform:Platform,secret:Buffer
}){
  const token=validateDeviceToken(input.token);
  const recipientId=uuid(input.recipientId);
  const app=appValue(input.app),platform=platformValue(input.platform);
  const secret=requireSecret(input.secret);
  const tokenDigest=createHmac('sha256',derived(secret,'lookup'))
    .update(token).digest('hex');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',
    derived(secret,'encryption'),iv);
  cipher.setAAD(Buffer.from([recipientId,app,platform].join('|')));
  const encrypted=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
  return Object.freeze({tokenDigest,
    tokenIv:iv.toString('hex'),tokenCipher:encrypted.toString('hex'),
    tokenTag:cipher.getAuthTag().toString('hex')});
}
export function unsealDeviceToken(row:{
  recipient_id:string,app:string,platform:string,
  token_iv:string,token_cipher:string,token_tag:string
},secret:Buffer){
  try{
    const decipher=createDecipheriv('aes-256-gcm',
      derived(requireSecret(secret),'encryption'),
      Buffer.from(row.token_iv,'hex'));
    decipher.setAAD(Buffer.from([row.recipient_id,row.app,row.platform].join('|')));
    decipher.setAuthTag(Buffer.from(row.token_tag,'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(row.token_cipher,'hex')),decipher.final()
    ]).toString('utf8');
  }catch{throw new NotificationError('NOTIFICATIONS_DEVICE_DECRYPT_FAILED');}
}
