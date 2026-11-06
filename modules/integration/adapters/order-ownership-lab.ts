/** M11 LAB4 — real M4 and M1 customer ownership bridge.
 * IMPORTANT: M4 and M1 use distinct identity/session databases. Neither
 * matching email nor an app-supplied UUID proves the same account owner.
 * Linking requires TWO valid sessions simultaneously, a matching canonical
 * email and active customer roles. No tokens or PII are stored in M11.
 * This adapter does not cancel orders, transfer funds or expose HTTP.
 */
import type {Pool,PoolClient} from 'pg';
import {readAuthenticatedProfile,readMyIdentityRole}
 from '../../users/src/auth.js';
import {resolveSession}
 from '../../../src/modules/orders/lab-auth.ts';
import {readOrderTimeline}
 from '../../../src/modules/orders/orders-read.ts';
import {OrderServiceError}
 from '../../../src/modules/orders/checkout.ts';
import {IntegrationError,validUuid} from '../src/events.js';
import type {OwnershipAssertion} from './identity-security-lab.js';

const INTEGRATION_DBS=['tala_integration_v2_test','tala_integration_v2_lab'];
const CORE_DBS=['tala_core_v2_test','tala_core_v2_lab'];
const forbidden=()=>process.env.NODE_ENV==='production';

export type IdentityLinkConfig={
 integrationPool:Pool,usersPool:Pool,ordersPool:Pool,
 usersPasswordPepper:Buffer
};

async function checkDb(pool:Pool,names:readonly string[]){
 if(forbidden())throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 const result=await pool.query<{name:string}>('SELECT current_database() AS name');
 if(!names.includes(result.rows[0]?.name??''))
  throw new IntegrationError('M11_LAB_ONLY');
}
async function integrationTx<T>(pool:Pool,
 run:(c:PoolClient)=>Promise<T>,readonly=false):Promise<T>{
 if(forbidden())throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 const c=await pool.connect();
 try{
  await c.query(readonly?'BEGIN READ ONLY':'BEGIN');
  await c.query("SET LOCAL statement_timeout='12000ms'");
  await c.query("SET LOCAL lock_timeout='3000ms'");
  const database=await c.query<{name:string}>('SELECT current_database() AS name');
  if(!INTEGRATION_DBS.includes(database.rows[0]?.name??''))
   throw new IntegrationError('M11_LAB_ONLY');
  const value=await run(c);
  await c.query('COMMIT');
  return value;
 }catch(error){
  await c.query('ROLLBACK').catch(()=>{});
  throw error;
 }finally{c.release();}
}
function assertSecret(secret:Buffer){
 if(!Buffer.isBuffer(secret)||secret.length<32)
  throw new IntegrationError('M11_AUTH_CONFIGURATION_INVALID');
}
function validatedConfig(config:IdentityLinkConfig){
 if(!config?.integrationPool||!config?.usersPool||!config?.ordersPool)
  throw new IntegrationError('M11_AUTH_CONFIGURATION_INVALID');
 assertSecret(config.usersPasswordPepper);
}

/** Enrolment: independently log into M4 and the legacy M1 account.
 * Both identities must be customer accounts and their canonical emails must
 * match; email equality alone is NEVER sufficient to bind.
 */
export async function linkControlledCustomerAccounts(
 config:IdentityLinkConfig,
 input:{m4SessionToken:string,m1SessionToken:string}
):Promise<Readonly<{linked:true,replayed:boolean,m4UserId:string,
 m1CustomerId:string,source:'dual_active_sessions_lab'}>>{
 if(forbidden())throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 validatedConfig(config);
 await checkDb(config.ordersPool,CORE_DBS);
 const [m4,m1]=await Promise.all([
  readAuthenticatedProfile(config.usersPool,{
   sessionToken:input.m4SessionToken,secret:config.usersPasswordPepper
  }).catch(()=>null),
  resolveSession(config.ordersPool,input.m1SessionToken).catch(()=>null)
 ]);
 if(!m4||!m1)
  throw new IntegrationError('M11_DUAL_SESSION_REQUIRED');
 const role=await readMyIdentityRole(config.usersPool,{
  sessionToken:input.m4SessionToken,secret:config.usersPasswordPepper
 }).catch(()=>null);
 if(role?.userId!==m4.id||role.role!=='customer'||m1.role!=='customer')
  throw new IntegrationError('M11_CUSTOMER_ROLE_REQUIRED');
 // M4 email was email-proofed before account activation. M1 legacy identity
 // is additionally authenticated with its own independent valid session.
 if(m4.email!==m1.email.toLowerCase().trim())
  throw new IntegrationError('M11_IDENTITY_EMAIL_MISMATCH');
 const m4UserId=validUuid(m4.id),m1CustomerId=validUuid(m1.id);
 return integrationTx(config.integrationPool,async c=>{
  const inserted=await c.query(
   'INSERT INTO tala_integration_v2.customer_identity_links '+
   '(m4_user_id,m1_customer_id) VALUES($1::uuid,$2::uuid) '+
   'ON CONFLICT DO NOTHING RETURNING m4_user_id',
   [m4UserId,m1CustomerId]);
  const current=await c.query<{m1_customer_id:string,revoked:boolean}>(
   'SELECT x.m1_customer_id,EXISTS('+
   'SELECT 1 FROM tala_integration_v2.customer_link_revocations r '+
   'WHERE r.m4_user_id=x.m4_user_id) AS revoked '+
   'FROM tala_integration_v2.customer_identity_links x '+
   'WHERE x.m4_user_id=$1::uuid',[m4UserId]);
  if(current.rows[0]?.revoked)
   throw new IntegrationError('M11_IDENTITY_LINK_REVOKED');
  if(current.rows[0]?.m1_customer_id!==m1CustomerId)
   throw new IntegrationError('M11_IDENTITY_LINK_CONFLICT');
  return Object.freeze({linked:true as const,replayed:inserted.rowCount===0,
   m4UserId,m1CustomerId,source:'dual_active_sessions_lab' as const});
 });
}

/** Approved incident action, never a public mutation. Permanent in LAB3/4. */
export async function revokeLinkedCustomerAccount(
 config:IdentityLinkConfig,
 trusted:{authenticated?:boolean,canRevokeIdentityLinks?:boolean},
 m4UserId:string,reason:'account_compromise'|'account_deleted'|
 'owner_request'|'admin_review'
){
 if(forbidden())throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 validatedConfig(config);
 if(trusted?.authenticated!==true||trusted?.canRevokeIdentityLinks!==true)
  throw new IntegrationError('M11_FORBIDDEN');
 const id=validUuid(m4UserId);
 if(!['account_compromise','account_deleted','owner_request',
  'admin_review'].includes(reason))
  throw new IntegrationError('M11_REVOCATION_REASON_INVALID');
 return integrationTx(config.integrationPool,async c=>{
  const result=await c.query(
   'INSERT INTO tala_integration_v2.customer_link_revocations '+
   '(m4_user_id,reason) VALUES($1::uuid,$2) '+
   'ON CONFLICT(m4_user_id) DO NOTHING RETURNING m4_user_id',[id,reason]);
  const linked=await c.query<{m4_user_id:string}>(
   'SELECT m4_user_id FROM tala_integration_v2.customer_identity_links '+
   'WHERE m4_user_id=$1::uuid',[id]);
  if(!linked.rows[0])
   throw new IntegrationError('M11_IDENTITY_LINK_NOT_FOUND');
  return Object.freeze({revoked:true as const,
   replayed:result.rowCount===0});
 });
}

/** Authoritative M1 ownership lookup; uses real M1 readOrderTimeline
 * instead of a forged boolean/UUID or foreign DB join. The M1 account must
 * STILL be an active customer on every authorization attempt.
 */
export function createVerifiedM1OwnershipResolver(config:IdentityLinkConfig){
 if(forbidden())throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 validatedConfig(config);
 return async(input:{subjectId:string,orderId:string}):
 Promise<OwnershipAssertion|null>=>{
  if(forbidden())throw new IntegrationError('M11_COMMERCIAL_DISABLED');
  const m4UserId=validUuid(input.subjectId),
   orderId=validUuid(input.orderId);
  const linked=await integrationTx(config.integrationPool,async c=>{
   const rows=await c.query<{m1_customer_id:string}>(
    'SELECT x.m1_customer_id FROM '+
    'tala_integration_v2.customer_identity_links x '+
    'WHERE x.m4_user_id=$1::uuid AND NOT EXISTS('+
    'SELECT 1 FROM tala_integration_v2.customer_link_revocations r '+
    'WHERE r.m4_user_id=x.m4_user_id)',[m4UserId]);
   return rows.rows[0]?.m1_customer_id??null;
  },true);
  if(!linked)return null;
  await checkDb(config.ordersPool,CORE_DBS);
  // Separate M1 database, explicitly read-only; never trust a cached role.
  const active=await config.ordersPool.query<{ok:boolean}>(
   'SELECT EXISTS(SELECT 1 FROM tala_core_v2.accounts '+
   "WHERE id=$1::uuid AND role='customer' AND is_active=true) AS ok",
   [linked]);
  if(active.rows[0]?.ok!==true)return null;
  try{
   const timeline=await readOrderTimeline(config.ordersPool,linked,'customer',
    orderId);
   if(timeline.orderId!==orderId)return null;
  }catch(error){
   if(error instanceof OrderServiceError&&
     error.code==='ORDER_NOT_FOUND')return null;
   // Infrastructure/policy errors MUST fail closed, not grant ownership.
   throw new IntegrationError('M11_OWNERSHIP_VERIFICATION_UNAVAILABLE');
  }
  return Object.freeze({subjectId:m4UserId,resourceId:orderId,
   allowed:true as const,
   evidenceSource:'trusted_lab_host' as const});
 };
}
