/**
 * TALA EATS CORE v2 — M4 Usuarios, independent domain contracts.
 * No checkout, payments, orders, logistics, financial wallets, or public auth.
 * This package is an internal laboratory: state facts must be authenticated
 * by a future trusted application adapter before use.
 */
import {createHash} from 'node:crypto';

export class UsersError extends Error {
  constructor(readonly code:string){
    super(code);
    this.name='UsersError';
  }
}
export type UserStatus='pending_verification'|'active'|'suspended'|
  'deletion_requested'|'deleted';
export type UserTransition='email_verified'|'suspend'|'reinstate'|
  'request_deletion'|'finalize_deletion';

export interface RegisterUser {
  email:string;
  displayName:string;
  idempotencyKey:string;
}
export interface TransitionUser {
  userId:string;
  actorId:string;
  action:UserTransition;
  expectedVersion:number;
  idempotencyKey:string;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY=/^[A-Za-z0-9._:-]{20,128}$/;
const DISPLAY=/^[\p{L}\p{N}][\p{L}\p{N} .'-]{1,79}$/u;
const LOCAL=/^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*$/;
const LABEL=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function requireUserId(value:unknown):string {
  if(typeof value!=='string'||!UUID.test(value))
    throw new UsersError('USERS_ID_INVALID');
  return value.toLowerCase();
}
export function canonicalEmail(value:unknown):string {
  if(typeof value!=='string')throw new UsersError('USERS_EMAIL_INVALID');
  const email=value.trim().toLowerCase();
  if(email.length>254||email.length<6||!/^[\x21-\x7e]+$/.test(email))
    throw new UsersError('USERS_EMAIL_INVALID');
  const parts=email.split('@');
  if(parts.length!==2)throw new UsersError('USERS_EMAIL_INVALID');
  const [local,domain]=parts;
  if(!local||!domain||local.length>64||!LOCAL.test(local)||
     domain.length>253||!domain.includes('.')||
     !domain.split('.').every(x=>LABEL.test(x))||
     /(^|\.)(invalid|local|localhost)$/i.test(domain))
    throw new UsersError('USERS_EMAIL_INVALID');
  return email;
}
export function canonicalDisplayName(value:unknown):string {
  if(typeof value!=='string')throw new UsersError('USERS_NAME_INVALID');
  const name=value.normalize('NFC').trim().replace(/ +/g,' ');
  if(name.length<2||Buffer.byteLength(name,'utf8')>180||!DISPLAY.test(name))
    throw new UsersError('USERS_NAME_INVALID');
  return name;
}
export function requireIdempotencyKey(value:unknown):string {
  if(typeof value!=='string'||!IDEMPOTENCY.test(value))
    throw new UsersError('USERS_COMMAND_INVALID');
  return value;
}
export function eventFingerprint(key:string,namespace:string):string {
  requireIdempotencyKey(key);
  if(!/^[a-z][a-z0-9._-]{2,48}$/.test(namespace))
    throw new UsersError('USERS_COMMAND_INVALID');
  return createHash('sha256').update('tala.users.v1|'+namespace+'|'+key)
    .digest('hex');
}
export const TARGET_STATUS:Readonly<Record<UserTransition,UserStatus>>=
  Object.freeze({
    email_verified:'active',
    suspend:'suspended',
    reinstate:'active',
    request_deletion:'deletion_requested',
    finalize_deletion:'deleted'
  });
const allowed:Readonly<Record<UserTransition,readonly UserStatus[]>>=
  Object.freeze({
    email_verified:['pending_verification'],
    suspend:['pending_verification','active'],
    reinstate:['suspended'],
    request_deletion:['pending_verification','active','suspended'],
    finalize_deletion:['deletion_requested']
  });
export function nextUserStatus(status:UserStatus,action:UserTransition):UserStatus {
  if(!Object.hasOwn(TARGET_STATUS,action)||!allowed[action]?.includes(status))
    throw new UsersError('USERS_STATE_TRANSITION_DENIED');
  return TARGET_STATUS[action];
}
export function assertVersion(version:unknown):number {
  if(!Number.isSafeInteger(version)||typeof version!=='number'||
     version<1||version>2_147_483_646)
    throw new UsersError('USERS_VERSION_INVALID');
  return version;
}
