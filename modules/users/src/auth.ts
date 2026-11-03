/** M4 Usuarios LAB2: internal identity flows. No HTTP or external modules. */
import {createHash,createHmac,randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {UsersError,canonicalEmail,canonicalDisplayName,
  eventFingerprint,assertVersion,requireIdempotencyKey} from './domain.js';

const LAB=new Set(['tala_users_v2_test','tala_users_v2_lab']);
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const DUMMY_SALT=Buffer.from('43d31221aabb7788bb98aabbeded4411','hex');
const SCRYPT_OPTIONS={N:16384,r:8,p:1,maxmem:32*1024*1024};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type UserRow={id:string,email_normalized:string,display_name:string,status:string,version:number};
type Audit={account_id:string,request_hash:string};
type LoginRow=UserRow & {salt_hex:string,verifier_hex:string,failed_attempts:number,locked:boolean};
const publicUser=(r:UserRow)=>Object.freeze({id:r.id,email:r.email_normalized,
  displayName:r.display_name,status:r.status,version:r.version});

function validSecret(value:unknown):Buffer{
  if(!Buffer.isBuffer(value)||value.length<32)
    throw new UsersError('USERS_AUTH_CONFIG_INVALID');
  return value;
}
function validToken(value:unknown):string{
  if(typeof value!=='string'||!TOKEN.test(value))
    throw new UsersError('USERS_SESSION_INVALID');
  return value;
}
export function checkNewPassword(value:unknown):string{
  if(typeof value!=='string'||value.length<12||value.length>128||
     Buffer.byteLength(value,'utf8')>256||
     /[\u0000-\u001f\u007f]/.test(value)||/^\s+$/.test(value)||
     /^(.)\1{11,}$/.test(value)||
     /^(?:password|contraseña|contrasena|123456789012)/i.test(value))
    throw new UsersError('USERS_PASSWORD_WEAK');
  return value;
}
function prehash(password:string,secret:Buffer):Buffer{
  return createHmac('sha256',secret)
    .update('tala.users.password.v1\0').update(password,'utf8').digest();
}
function tokenHash(token:string,secret:Buffer):string{
  return createHmac('sha256',secret)
    .update('tala.users.session.v1\0').update(token).digest('hex');
}
async function derive(password:string,salt:Buffer,secret:Buffer):Promise<Buffer>{
  const bytes=prehash(password,secret);
  try{
    return await new Promise<Buffer>((resolve,reject)=>{
      scrypt(bytes,salt,32,SCRYPT_OPTIONS,(error,result)=>{
        if(error)reject(error);else resolve(result);
      });
    });
  }finally{bytes.fill(0);}
}
async function passwordMaterial(password:string,secret:Buffer){
  const salt=randomBytes(16),verifier=await derive(password,salt,secret);
  return {saltHex:salt.toString('hex'),verifierHex:verifier.toString('hex')};
}
async function matches(password:string,saltHex:string,verifierHex:string,
  secret:Buffer):Promise<boolean>{
  const attempt=await derive(password,Buffer.from(saltHex,'hex'),secret);
  const expected=Buffer.from(verifierHex,'hex');
  return attempt.length===expected.length&&timingSafeEqual(attempt,expected);
}
async function tx<T>(pool:Pool,fn:(c:PoolClient)=>Promise<T>,
  readOnly=false):Promise<T>{
  const c=await pool.connect();
  try{
    await c.query(readOnly?'BEGIN READ ONLY':'BEGIN');
    await c.query("SET LOCAL statement_timeout='15000ms'");
    await c.query("SET LOCAL lock_timeout='5000ms'");
    const r=await c.query<{name:string}>('SELECT current_database() AS name');
    if(!LAB.has(r.rows[0]?.name??''))throw new UsersError('USERS_LAB_ONLY');
    const value=await fn(c);
    await c.query('COMMIT');
    return value;
  }catch(error){
    await c.query('ROLLBACK').catch(()=>{});
    if(error&&typeof error==='object'&&'code' in error&&
       (error as {code?:string}).code==='23505')
      throw new UsersError('USERS_UNIQUE_CONFLICT');
    throw error;
  }finally{c.release();}
}
async function readAudit(c:PoolClient,key:string):Promise<Audit|null>{
  const r=await c.query<Audit>(
    'SELECT account_id,request_hash FROM tala_users_v2.account_audit WHERE event_key=$1',
    [key]);
  return r.rows[0]??null;
}

/** Password and pending account created atomically, before email proof. */
export async function registerCredentialedPendingUser(pool:Pool,{
  email,displayName,password,secret,idempotencyKey
}:{email:string,displayName:string,password:string,secret:Buffer,
  idempotencyKey:string}){
  const normalized=canonicalEmail(email),name=canonicalDisplayName(displayName);
  const pepper=validSecret(secret),pass=checkNewPassword(password);
  const eventKey=eventFingerprint(requireIdempotencyKey(idempotencyKey),
    'register_pending');
  const requestHash=hash(['credentialed_register',eventKey,normalized,name,
    prehash(pass,pepper).toString('hex')]);
  const material=await passwordMaterial(pass,pepper);
  return tx(pool,async c=>{
    const inserted=await c.query<UserRow>(`
      INSERT INTO tala_users_v2.accounts(email_normalized,display_name)
      VALUES ($1,$2) ON CONFLICT DO NOTHING
      RETURNING id,email_normalized,display_name,status,version`,
      [normalized,name]);
    if(inserted.rowCount){
      const user=inserted.rows[0]!;
      await c.query(`
        INSERT INTO tala_users_v2.password_credentials
          (account_id,salt_hex,verifier_hex) VALUES($1::uuid,$2,$3)`,
        [user.id,material.saltHex,material.verifierHex]);
      await c.query(`
        INSERT INTO tala_users_v2.account_audit
          (account_id,event_key,request_hash,action,from_status,to_status)
        VALUES($1::uuid,$2,$3,'register_pending',NULL,'pending_verification')`,
        [user.id,eventKey,requestHash]);
      return Object.freeze({user:publicUser(user),replayed:false});
    }
    const found=await c.query<UserRow>(`
      SELECT id,email_normalized,display_name,status,version
      FROM tala_users_v2.accounts WHERE email_normalized=$1 FOR UPDATE`,
      [normalized]);
    const old=await readAudit(c,eventKey);
    if(!found.rows[0]||!old||old.account_id!==found.rows[0].id||
       old.request_hash!==requestHash)
      throw new UsersError('USERS_EMAIL_OR_COMMAND_CONFLICT');
    return Object.freeze({user:publicUser(found.rows[0]),replayed:true});
  });
}

/** Generic auth failure for wrong/missing/locked/inactive accounts. */
export async function loginLabUser(pool:Pool,{
  email,password,secret
}:{email:string,password:string,secret:Buffer}){
  const pepper=validSecret(secret);
  let normalized:string;
  try{normalized=canonicalEmail(email);}
  catch{normalized='missing@users.invalid';}
  const candidate=typeof password==='string'&&
    Buffer.byteLength(password,'utf8')<=256?password:'';
  const outcome=await tx(pool,async c=>{
    const result=await c.query<LoginRow>(`
      SELECT a.id,a.email_normalized,a.display_name,a.status,a.version,
        p.salt_hex,p.verifier_hex,p.failed_attempts,
        (p.locked_until>clock_timestamp()) AS locked
      FROM tala_users_v2.accounts a
      JOIN tala_users_v2.password_credentials p ON p.account_id=a.id
      WHERE a.email_normalized=$1 FOR UPDATE OF a,p`,[normalized]);
    const row=result.rows[0];
    const correct=await matches(candidate,
      row?.salt_hex??DUMMY_SALT.toString('hex'),
      row?.verifier_hex??'0'.repeat(64),pepper);
    if(!row||row.status!=='active'||row.locked||!correct){
      if(row&&row.status==='active'&&!row.locked){
        await c.query(`
          UPDATE tala_users_v2.password_credentials SET
            failed_attempts=CASE WHEN locked_until<=clock_timestamp()
              THEN 1 ELSE LEAST(5,failed_attempts+1) END,
            locked_until=CASE WHEN
              (CASE WHEN locked_until<=clock_timestamp()
                THEN 1 ELSE failed_attempts+1 END)>=5
              THEN clock_timestamp()+interval '10 minutes'
              ELSE NULL END,
            updated_at=clock_timestamp()
          WHERE account_id=$1::uuid`,[row.id]);
      }
      return {error:'USERS_INVALID_CREDENTIALS' as const};
    }
    await c.query(`
      UPDATE tala_users_v2.password_credentials SET
        failed_attempts=0,locked_until=NULL,updated_at=clock_timestamp()
      WHERE account_id=$1::uuid`,[row.id]);
    const sessionToken=randomBytes(32).toString('base64url');
    await c.query(`
      WITH issued AS (SELECT clock_timestamp() AS at)
      INSERT INTO tala_users_v2.sessions
        (token_digest,account_id,created_at,expires_at)
      SELECT $1,$2::uuid,issued.at,issued.at+interval '12 hours'
      FROM issued`,[tokenHash(sessionToken,pepper),row.id]);
    return {userId:row.id,sessionToken,expiresInSeconds:43200};
  });
  if('error' in outcome)throw new UsersError(outcome.error);
  return Object.freeze(outcome);
}
async function sessionUser(c:PoolClient,token:string,secret:Buffer,lock=false){
  const lockClause=lock?' FOR UPDATE OF a':'';
  const r=await c.query<UserRow>(
    'SELECT a.id,a.email_normalized,a.display_name,a.status,a.version '+
    'FROM tala_users_v2.accounts a JOIN tala_users_v2.sessions s '+
    'ON s.account_id=a.id WHERE s.token_digest=$1 AND s.revoked_at IS NULL '+
    "AND s.expires_at>clock_timestamp() AND a.status='active'"+
    lockClause,[tokenHash(validToken(token),secret)]);
  if(!r.rows[0])throw new UsersError('USERS_SESSION_INVALID');
  return r.rows[0];
}
