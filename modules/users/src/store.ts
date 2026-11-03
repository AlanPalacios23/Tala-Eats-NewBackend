/**
 * M4 Usuarios only: internal-only transactions. No HTTP endpoints, no
 * password/session verification and NO authentication/authorization adapter.
 * In production an authenticated service must gate EVERY mutation, and a
 * trusted verification service must attest email_verified transitions.
 */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {
  UsersError,canonicalEmail,canonicalDisplayName,requireUserId,
  eventFingerprint,nextUserStatus,assertVersion,requireIdempotencyKey,
  type RegisterUser,type TransitionUser,type UserStatus
} from './domain.js';

type DbRow={id:string,email_normalized:string,display_name:string,
  status:UserStatus,version:number,created_at:Date,updated_at:Date};
type Event={account_id:string,request_hash:string,to_status:UserStatus};
const LAB=new Set(['tala_users_v2_lab','tala_users_v2_test']);
const hash=(input:unknown)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
const requirePg=async(c:PoolClient)=>{
  const d=await c.query<{name:string}>('SELECT current_database() AS name');
  if(!LAB.has(d.rows[0]?.name??''))throw new UsersError('USERS_LAB_ONLY');
};
async function transaction<T>(pool:Pool,work:(c:PoolClient)=>Promise<T>,readOnly=false):Promise<T>{
  const c=await pool.connect();
  try{
    await c.query(readOnly?'BEGIN READ ONLY':'BEGIN');
    await c.query("SET LOCAL lock_timeout='3000ms'");
    await c.query("SET LOCAL statement_timeout='10000ms'");
    await requirePg(c);
    const result=await work(c);
    await c.query('COMMIT');
    return result;
  }catch(error){
    await c.query('ROLLBACK').catch(()=>{});
    if(typeof error==='object'&&error!==null&&'code' in error&&
       (error as {code?:string}).code==='23505')
      throw new UsersError('USERS_UNIQUE_CONFLICT');
    throw error;
  }finally{c.release();}
}
const readEvent=async(c:PoolClient,eventKey:string)=>{
  const r=await c.query<Event>(
    'SELECT account_id,request_hash,to_status FROM tala_users_v2.account_audit WHERE event_key=$1',
    [eventKey]);
  return r.rows[0]??null;
};
const clean=(row:DbRow)=>Object.freeze({
  id:row.id,email:row.email_normalized,
  displayName:row.display_name,status:row.status,version:row.version
});

/** Internal registration, no credentials/session. Always pending verification. */
export async function registerPendingUser(pool:Pool,input:RegisterUser){
  const email=canonicalEmail(input.email);
  const displayName=canonicalDisplayName(input.displayName);
  const command=requireIdempotencyKey(input.idempotencyKey);
  const eventKey=eventFingerprint(command,'register_pending');
  const requestHash=hash(['register_pending',eventKey,email,displayName]);
  return transaction(pool,async c=>{
    const inserted=await c.query<DbRow>(`
      INSERT INTO tala_users_v2.accounts(email_normalized,display_name)
      VALUES ($1,$2) ON CONFLICT DO NOTHING
      RETURNING id,email_normalized,display_name,status,version,created_at,updated_at`,
      [email,displayName]);
    if(inserted.rowCount){
      const account=inserted.rows[0]!;
      await c.query(`
        INSERT INTO tala_users_v2.account_audit
          (account_id,event_key,request_hash,action,from_status,to_status)
        VALUES($1::uuid,$2,$3,'register_pending',NULL,'pending_verification')`,
        [account.id,eventKey,requestHash]);
      return Object.freeze({user:clean(account),replayed:false});
    }
    const account=await c.query<DbRow>(`
      SELECT id,email_normalized,display_name,status,version,created_at,updated_at
      FROM tala_users_v2.accounts WHERE email_normalized=$1 FOR UPDATE`,[email]);
    const event=await readEvent(c,eventKey);
    if(!account.rowCount||!event||
       event.account_id!==account.rows[0]!.id||
       event.request_hash!==requestHash)
      throw new UsersError('USERS_EMAIL_OR_COMMAND_CONFLICT');
    return Object.freeze({user:clean(account.rows[0]!),replayed:true});
  });
}

/**
 * State facts are trusted/internal LAB inputs ONLY. actorId is an audit
 * identifier, NOT an authorization proof. Do not expose via HTTP.
 */
export async function transitionLabUser(pool:Pool,input:TransitionUser){
  const userId=requireUserId(input.userId);
  const actorId=requireUserId(input.actorId);
  const expectedVersion=assertVersion(input.expectedVersion);
  const action=input.action;
  if(typeof action!=='string'||!Object.hasOwn({
    email_verified:1,suspend:1,reinstate:1,
    request_deletion:1,finalize_deletion:1
  },action))
    throw new UsersError('USERS_ACTION_INVALID');
  const eventKey=eventFingerprint(input.idempotencyKey,'transition');
  const requestHash=hash(['transition',eventKey,userId,actorId,action,expectedVersion]);
  return transaction(pool,async c=>{
    const found=await c.query<DbRow>(`
      SELECT id,email_normalized,display_name,status,version,created_at,updated_at
      FROM tala_users_v2.accounts WHERE id=$1::uuid FOR UPDATE`,[userId]);
    if(!found.rowCount)throw new UsersError('USERS_NOT_FOUND');
    const account=found.rows[0]!;
    const oldEvent=await readEvent(c,eventKey);
    if(oldEvent){
      if(oldEvent.account_id!==userId||oldEvent.request_hash!==requestHash)
        throw new UsersError('USERS_IDEMPOTENCY_CONFLICT');
      return Object.freeze({user:clean(account),replayed:true,
        appliedStatus:oldEvent.to_status});
    }
    if(account.version!==expectedVersion)
      throw new UsersError('USERS_VERSION_CONFLICT');
    const next=nextUserStatus(account.status,action);
    const result=await c.query<DbRow>(`
      UPDATE tala_users_v2.accounts SET
        status=$2,
        version=version+1,
        email_verified_at=CASE WHEN $3='email_verified'
          THEN clock_timestamp() ELSE email_verified_at END,
        email_normalized=CASE WHEN $3='finalize_deletion'
          THEN 'deleted.'||id::text||'@users.invalid' ELSE email_normalized END,
        display_name=CASE WHEN $3='finalize_deletion'
          THEN 'Cuenta eliminada' ELSE display_name END,
        deleted_at=CASE WHEN $3='finalize_deletion'
          THEN clock_timestamp() ELSE deleted_at END,
        updated_at=clock_timestamp()
      WHERE id=$1::uuid
      RETURNING id,email_normalized,display_name,status,version,created_at,updated_at`,
      [userId,next,action]);
    await c.query(`
      INSERT INTO tala_users_v2.account_audit
        (account_id,event_key,request_hash,action,from_status,to_status,actor_id)
      VALUES($1::uuid,$2,$3,$4,$5,$6,$7::uuid)`,
      [userId,eventKey,requestHash,action,account.status,next,actorId]);
    return Object.freeze({user:clean(result.rows[0]!),replayed:false,
      appliedStatus:next});
  });
}

export async function updateLabOwnProfile(pool:Pool,{
  userId,actorId,displayName,expectedVersion,idempotencyKey
}:{userId:string,actorId:string,displayName:string,
  expectedVersion:number,idempotencyKey:string}){
  const id=requireUserId(userId),actor=requireUserId(actorId);
  if(id!==actor)throw new UsersError('USERS_PROFILE_ACTOR_DENIED');
  const name=canonicalDisplayName(displayName);
  const version=assertVersion(expectedVersion);
  const eventKey=eventFingerprint(idempotencyKey,'profile_updated');
  const requestHash=hash(['profile_updated',eventKey,id,actor,name,version]);
  return transaction(pool,async c=>{
    const found=await c.query<DbRow>(`
      SELECT id,email_normalized,display_name,status,version,created_at,updated_at
      FROM tala_users_v2.accounts WHERE id=$1::uuid FOR UPDATE`,[id]);
    if(!found.rowCount)throw new UsersError('USERS_NOT_FOUND');
    const account=found.rows[0]!;
    const oldEvent=await readEvent(c,eventKey);
    if(oldEvent){
      if(oldEvent.account_id!==id||oldEvent.request_hash!==requestHash)
        throw new UsersError('USERS_IDEMPOTENCY_CONFLICT');
      return Object.freeze({user:clean(account),replayed:true});
    }
    if(account.version!==version)throw new UsersError('USERS_VERSION_CONFLICT');
    if(account.status!=='active')throw new UsersError('USERS_PROFILE_STATE_DENIED');
    if(name===account.display_name)
      throw new UsersError('USERS_PROFILE_UNCHANGED');
    const updated=await c.query<DbRow>(`
      UPDATE tala_users_v2.accounts SET display_name=$2,
        version=version+1,updated_at=clock_timestamp()
      WHERE id=$1::uuid
      RETURNING id,email_normalized,display_name,status,version,created_at,updated_at`,
      [id,name]);
    await c.query(`
      INSERT INTO tala_users_v2.account_audit
        (account_id,event_key,request_hash,action,from_status,to_status,actor_id)
      VALUES($1::uuid,$2,$3,'profile_updated','active','active',$4::uuid)`,
      [id,eventKey,requestHash,actor]);
    return Object.freeze({user:clean(updated.rows[0]!),replayed:false});
  });
}

/** PII-bearing internal read: caller must be authenticated outside this lab. */
export async function readLabUser(pool:Pool,userId:string){
  const id=requireUserId(userId);
  return transaction(pool,async c=>{
    const r=await c.query<DbRow>(`
      SELECT id,email_normalized,display_name,status,version,created_at,updated_at
      FROM tala_users_v2.accounts WHERE id=$1::uuid`,[id]);
    return r.rows[0]?clean(r.rows[0]):null;
  },true);
}
