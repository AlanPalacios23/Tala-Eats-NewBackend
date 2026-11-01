/** CORE v2 LAB: database-backed sessions. No role can be chosen at registration. */
import {randomBytes,scrypt as scryptCallback,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import type {Pool} from 'pg';

const scrypt=promisify(scryptCallback);
export const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
export function newSessionToken():string{return randomBytes(32).toString('hex');}
export async function hashPassword(password:string):Promise<string>{
  const salt=randomBytes(16).toString('hex');
  const hash=await scrypt(password,salt,64) as Buffer;
  return 'scrypt:'+salt+':'+hash.toString('hex');
}
export async function verifyPassword(password:string,stored:string):Promise<boolean>{
  const parts=stored.split(':');
  if(parts.length!==3||parts[0]!=='scrypt'||!parts[1]||!/^[a-f0-9]{128}$/.test(parts[2]??''))return false;
  const derived=await scrypt(password,parts[1],64) as Buffer;
  return timingSafeEqual(derived,Buffer.from(parts[2]!, 'hex'));
}
export type Identity={id:string;email:string;role:'customer'|'merchant';displayName:string};
export async function resolveSession(pool:Pool,token:string|undefined):Promise<Identity|null>{
  if(!token||!/^[a-f0-9]{64}$/.test(token))return null;
  const {rows}=await pool.query<{id:string;email:string;role:'customer'|'merchant';display_name:string}>(`
    SELECT a.id,a.email,a.role,a.display_name
    FROM tala_core_v2.sessions s
    JOIN tala_core_v2.accounts a ON a.id=s.account_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND a.is_active=true`,[tokenHash(token)]);
  const a=rows[0];return a?{id:a.id,email:a.email,role:a.role,displayName:a.display_name}:null;
}
export async function issueSession(pool:Pool,accountId:string):Promise<string>{
  const token=newSessionToken();
  await pool.query(`
    INSERT INTO tala_core_v2.sessions(token_hash,account_id,expires_at)
    VALUES ($1,$2::uuid,now()+interval '24 hours')`,[tokenHash(token),accountId]);
  return token;
}
export const sessionCookie=(token:string,secure:boolean)=>
  'core_v2_session='+token+'; HttpOnly; Path=/; SameSite=Strict; Max-Age=86400'+(secure?'; Secure':'');
export const clearedSessionCookie=(secure:boolean)=>
  'core_v2_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0'+(secure?'; Secure':'');
export function getSessionToken(cookieHeader:string|undefined):string|undefined{
  return cookieHeader?.split(';').map(x=>x.trim()).find(x=>x.startsWith('core_v2_session='))?.slice(16);
}
