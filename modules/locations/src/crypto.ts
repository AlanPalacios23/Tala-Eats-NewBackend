import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {LocationError} from './domain.js';
export type Encrypted={ciphertext:Buffer,nonce:Buffer,authTag:Buffer};
export class PrivateLocationCipher {
 private readonly key:Buffer;
 constructor(key:Buffer){
  if(!Buffer.isBuffer(key)||key.length!==32)
    throw new LocationError('M7_ENCRYPTION_KEY_INVALID');
  this.key=Buffer.from(key);
 }
 encrypt(ownerId:string,recordId:string,data:unknown):Encrypted{
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',this.key,nonce);
  cipher.setAAD(Buffer.from('m7|'+ownerId+'|'+recordId+'|v1'));
  const ciphertext=Buffer.concat([
    cipher.update(JSON.stringify(data),'utf8'),cipher.final()]);
  return {ciphertext,nonce,authTag:cipher.getAuthTag()};
 }
 decrypt<T>(ownerId:string,recordId:string,payload:Encrypted):T{
  try{
   const dec=createDecipheriv('aes-256-gcm',this.key,payload.nonce);
   dec.setAAD(Buffer.from('m7|'+ownerId+'|'+recordId+'|v1'));
   dec.setAuthTag(payload.authTag);
   return JSON.parse(Buffer.concat([
     dec.update(payload.ciphertext),dec.final()]).toString('utf8')) as T;
  }catch{throw new LocationError('M7_DECRYPT_FAILED');}
 }
}
