/**
 * LAB-only end-to-end commercial-application boundary for Tala Eats Crece.
 *
 * M4 authenticates the ACTUAL session and current role, M6 independently
 * verifies the exact store owner, M9 consumes a one-use resource-bound grant,
 * M11 persists idempotent consent/interest/reviews/atomic quota.
 *
 * No HTTP entrypoint, no Stripe or LIVE payment permission. No actorId is
 * supplied by the caller. Production deliberately fails closed.
 */
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {requireLabAccountRole} from '../../users/src/auth.js';
import {readStore} from '../../restaurants/src/stores.js';
import {authorizeSecurityAction,type SecurityConfig} from
 '../../security/src/gate.js';
import {signHostGrant,type HostGrant,type SecurityAction} from
 '../../security/src/grants.js';
import {IntegrationError,validUuid} from '../src/events.js';
import {recordCreceInterestLab} from './crece-founders-lab.js';

const PILOT='crece-founder-pilot-2026-11-v1';
const LIST_RESOURCE='f070d0a1-0000-4000-8000-000000000010';
type Role='merchant'|'staff'|'owner';
type Decision='approved'|'declined';
type Reason='information_incomplete'|'not_eligible'|'pilot_full'|
 'owner_request'|'other';
const REASONS=new Set<Reason>([
 'information_incomplete','not_eligible','pilot_full','owner_request','other'
]);
type Config={
 usersPool:Pool;usersPasswordPepper:Buffer;
 restaurantsPool:Pool;integrationPool:Pool;
 security:SecurityConfig;grantKeyId:string
};
type ReviewRow={
 application_id:string;operation_id:string;reviewer_id:string;
 decision:Decision;reason_code:Reason|null
};
type AdminStatus='interested'|Decision;
type AdminCursor={createdAt:string;applicationId:string};
function listPage(input:{limit?:number;status?:AdminStatus;cursor?:AdminCursor}){
 const limit=input.limit??25;
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)
  throw new IntegrationError('M11_CRECE_PAGE_LIMIT_INVALID');
 if(input.status!==undefined&&
    !['interested','approved','declined'].includes(input.status))
  throw new IntegrationError('M11_CRECE_STATUS_FILTER_INVALID');
 const cursor=input.cursor;
 if(cursor!==undefined){
  if(!cursor||typeof cursor.createdAt!=='string'||
   !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.createdAt)||
   !Number.isFinite(Date.parse(cursor.createdAt))||
   new Date(cursor.createdAt).toISOString()!==cursor.createdAt)
   throw new IntegrationError('M11_CRECE_CURSOR_INVALID');
  try{validUuid(cursor.applicationId);}
  catch{throw new IntegrationError('M11_CRECE_CURSOR_INVALID');}
 }
 return {limit,status:input.status??null,cursor:cursor??null};
}

function labOnly(){
 if(process.env.NODE_ENV==='production'||
  process.env.CORE_V2_INTEGRATION_RUNTIME!=='isolated-lab'||
  process.env.CORE_V2_INTEGRATION_PUBLIC_HTTP_ENABLED==='true')
  throw new IntegrationError('M11_CRECE_COMMERCIAL_DISABLED');
}
function configCheck(config:Config){
 labOnly();
 if(!config||!config.integrationPool||!config.restaurantsPool||
  !config.usersPool||!Buffer.isBuffer(config.usersPasswordPepper)||
  config.usersPasswordPepper.length<32||!config.security||
  typeof config.grantKeyId!=='string')
  throw new IntegrationError('M11_CRECE_CONFIG_INVALID');
}
async function correctDb(pool:Pool,expected:string){
 const row=await pool.query<{db:string}>('SELECT current_database() AS db');
 if(row.rows[0]?.db!==expected)
  throw new IntegrationError('M11_CRECE_LAB_ONLY');
}
async function authenticated(config:Config,sessionToken:string,
 roles:readonly Role[]){
 labOnly();
 try{
  const claims=await requireLabAccountRole(config.usersPool,{
   sessionToken,secret:config.usersPasswordPepper,allowedRoles:roles
  });
  return validUuid(claims.userId);
 }catch{
  throw new IntegrationError('M11_CRECE_SESSION_OR_ROLE_DENIED');
 }
}
async function grant(config:Config,subjectId:string,
 action:SecurityAction,resourceId:string){
 labOnly();
 const now=Math.floor(Date.now()/1000);
 // The role-gated M4 session is independently revalidated every call.
 // In particular, privileged accounts must already have MFA at login.
 const claim:HostGrant={
  version:1,issuer:'tala-trusted-gateway-lab',
  audience:'m9-security-lab',grantId:randomUUID(),
  subjectId,resourceId,action,
  assurance:'session',assuranceAt:null,
  issuedAt:now-1,expiresAt:now+40
 };
 const signed=signHostGrant(claim,config.grantKeyId,config.security.keyring);
 const result=await authorizeSecurityAction(config.security,{
  grant:signed,action,resourceId
 });
 if(!result.allowed)
  throw new IntegrationError('M11_CRECE_M9_DENIED');
}
async function tx<T>(pool:Pool,run:(client:PoolClient)=>Promise<T>,
 readonly=false):Promise<T>{
 const c=await pool.connect();
 try{
  await c.query(readonly?'BEGIN READ ONLY':'BEGIN');
  await c.query("SET LOCAL statement_timeout='12000ms'");
  await c.query("SET LOCAL lock_timeout='3000ms'");
  const db=await c.query<{db:string}>('SELECT current_database() AS db');
  if(db.rows[0]?.db!=='tala_integration_v2_test')
   throw new IntegrationError('M11_CRECE_LAB_ONLY');
  const result=await run(c);
  await c.query('COMMIT');
  return result;
 }catch(error){
  await c.query('ROLLBACK').catch(()=>{});
  throw error;
 }finally{c.release();}
}

export function createCreceEnrollmentLab(config:Config){
 configCheck(config);
 return Object.freeze({
  /** A real authenticated merchant and M6 owner can agree to terms.
   * Marketing opt-in must be presented as a distinct optional control.
   */
  submit:async(input:{
   sessionToken:string;storeId:string;operationId:string;
   termsAccepted:true;agreementVersion:string;marketingOptIn:boolean
  })=>{
   configCheck(config);
   const storeId=validUuid(input.storeId),
    operationId=validUuid(input.operationId);
   if(input.termsAccepted!==true||input.agreementVersion!==PILOT||
     typeof input.marketingOptIn!=='boolean')
    throw new IntegrationError('M11_CRECE_EXPLICIT_TERMS_REQUIRED');
   const subjectId=await authenticated(config,input.sessionToken,['merchant']);
   // M6 is the only authoritative owner registry; a valid merchant role
   // alone never grants rights over arbitrary foreign stores.
   const store=await readStore(config.restaurantsPool,{actorId:subjectId},storeId)
    .catch(()=>null);
   if(store?.store?.owner_id!==subjectId)
    throw new IntegrationError('M11_CRECE_OWNER_REQUIRED');
   await grant(config,subjectId,'crece.interest.submit',storeId);
   const result=await recordCreceInterestLab(config,{
    storeId,staffActorId:subjectId,operationId,
    termsAccepted:true,termsVersion:input.agreementVersion,
    marketingOptIn:input.marketingOptIn
   });
   return Object.freeze({...result,merchantId:storeId,
    consentRecorded:true as const,
    founderSeatGranted:false as const});
  },
  /** Paged admin query contains only safe IDs and status (no PII).
   * Cursor is keyset-based and never skips over 100+ applicants.
   * Access remains M4 MFA staff/owner + M9 scoped one-use grant.
   */
  listForAdmin:async(input:{
   sessionToken:string;limit?:number;status?:AdminStatus;
   cursor?:AdminCursor
  })=>{
   configCheck(config);
   const {limit,status,cursor}=listPage(input);
   const actorId=await authenticated(config,input.sessionToken,['staff','owner']);
   await grant(config,actorId,'crece.founder.list',LIST_RESOURCE);
   return tx(config.integrationPool,async c=>{
    const rows=await c.query<{
     application_id:string;m6_store_id:string;
     created_at:Date;decision:Decision|null;
    }>(
     'SELECT i.application_id,i.m6_store_id,i.created_at,'+
     'r.decision FROM tala_integration_v2.crece_founder_interest i '+
     'LEFT JOIN tala_integration_v2.crece_founder_reviews r '+
     'ON r.application_id=i.application_id '+
     'JOIN tala_integration_v2.crece_founder_consents consent '+
     'ON consent.application_id=i.application_id '+
     'WHERE ($1::timestamptz IS NULL OR '+
     '(date_trunc(\'milliseconds\',i.created_at),i.application_id)>'+
     '($1::timestamptz,$2::uuid)) '+
     'AND ($3::text IS NULL OR COALESCE(r.decision,\'interested\')=$3) '+
     'ORDER BY date_trunc(\'milliseconds\',i.created_at) ASC,'+
     'i.application_id ASC LIMIT $4',
     [cursor?.createdAt??null,cursor?.applicationId??null,status,limit+1]);
    const quota=await c.query<{capacity:number;approved_count:number}>(
     'SELECT capacity,approved_count FROM tala_integration_v2.crece_founder_quota '+
     'WHERE program_id=$1',[PILOT]);
    const cap=quota.rows[0];
    if(!cap)throw new IntegrationError('M11_CRECE_QUOTA_UNAVAILABLE');
    const visible=rows.rows.slice(0,limit);
    const last=visible.at(-1);
    const nextCursor=rows.rows.length>limit&&last?
     Object.freeze({createdAt:new Date(last.created_at).toISOString(),
      applicationId:last.application_id}):null;
    return Object.freeze({capacity:cap.capacity,
     seatsApproved:cap.approved_count,
     seatsRemaining:cap.capacity-cap.approved_count,
     nextCursor,
     applicants:visible.map(r=>Object.freeze({
      applicationId:r.application_id,storeId:r.m6_store_id,
      createdAt:new Date(r.created_at).toISOString(),
      status:r.decision??'interested'
     }))});
   },true);
  },
  /** An authenticated, MFA-enabled M4 staff/owner can decide once.
   * M9 resource scope is the *application*, not an app-provided actor ID.
   * M11 trigger allocates one of exactly ten seats atomically.
   */
  review:async(input:{
   sessionToken:string;applicationId:string;operationId:string;
   decision:Decision;reasonCode?:Reason
  })=>{
   configCheck(config);
   const applicationId=validUuid(input.applicationId),
    operationId=validUuid(input.operationId);
   if(input.decision!=='approved'&&input.decision!=='declined')
    throw new IntegrationError('M11_CRECE_DECISION_INVALID');
   if(input.reasonCode!==undefined&&!REASONS.has(input.reasonCode))
    throw new IntegrationError('M11_CRECE_REASON_INVALID');
   if(input.decision==='declined'&&!input.reasonCode)
    throw new IntegrationError('M11_CRECE_REASON_REQUIRED');
   const actorId=await authenticated(config,input.sessionToken,
    ['staff','owner']);
   await grant(config,actorId,'crece.founder.review',applicationId);
   return tx(config.integrationPool,async c=>{
    const interest=await c.query<{
     application_id:string;m6_store_id:string;m6_staff_actor_id:string
    }>(
     'SELECT application_id,m6_store_id,m6_staff_actor_id '+
     'FROM tala_integration_v2.crece_founder_interest '+
     'WHERE application_id=$1::uuid FOR UPDATE',[applicationId]);
    if(!interest.rows[0])
     throw new IntegrationError('M11_CRECE_APPLICATION_NOT_FOUND');
    const prior=await c.query<ReviewRow>(
     'SELECT application_id,operation_id,reviewer_id,decision,reason_code '+
     'FROM tala_integration_v2.crece_founder_reviews '+
     'WHERE application_id=$1::uuid FOR UPDATE',[applicationId]);
    const existing=prior.rows[0];
    if(existing){
     if(existing.operation_id!==operationId||
        existing.reviewer_id!==actorId||
        existing.decision!==input.decision||
        existing.reason_code!==(input.reasonCode??null))
      throw new IntegrationError('M11_CRECE_ALREADY_REVIEWED');
     return Object.freeze({applicationId,decision:existing.decision,
      replayed:true,founderSeatGranted:existing.decision==='approved'});
    }
    if(input.decision==='approved'){
     // Review may happen days after application. Recheck the applicant's
     // CURRENT M4 account role and active status, plus CURRENT M6 owner.
     // This denies revoked/changed business owners, even when original
     // consent was valid. Never trust the stale interest row as authority.
     const applicant=interest.rows[0]!;
     const state=await config.usersPool.query<{
      role:string;status:string;verified:boolean
     }>(
      'SELECT roles.role,a.status,'+
      '(a.email_verified_at IS NOT NULL) AS verified '+
      'FROM tala_users_v2.accounts a '+
      'JOIN tala_users_v2.account_roles roles ON roles.account_id=a.id '+
      'WHERE a.id=$1::uuid',[applicant.m6_staff_actor_id]);
     if(state.rows[0]?.role!=='merchant'||
        state.rows[0]?.status!=='active'||
        state.rows[0]?.verified!==true)
      throw new IntegrationError('M11_CRECE_APPLICANT_NO_LONGER_ELIGIBLE');
     const owned=await readStore(config.restaurantsPool,
      {actorId:applicant.m6_staff_actor_id},applicant.m6_store_id)
      .catch(()=>null);
     if(owned?.store?.owner_id!==applicant.m6_staff_actor_id)
      throw new IntegrationError('M11_CRECE_APPLICANT_NO_LONGER_ELIGIBLE');
    }
    try{
     await c.query(
      'INSERT INTO tala_integration_v2.crece_founder_reviews '+
      '(application_id,operation_id,reviewer_id,decision,reason_code) '+
      'VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5)',
      [applicationId,operationId,actorId,input.decision,
       input.reasonCode??null]);
    }catch(error){
     if(error&&typeof error==='object'&&'message' in error&&
       String(error.message).includes('CRECE_FOUNDER_CAPACITY_FULL'))
      throw new IntegrationError('M11_CRECE_CAPACITY_FULL');
     if(error&&typeof error==='object'&&'message' in error&&
       String(error.message).includes('CRECE_TERMS_REQUIRED'))
      throw new IntegrationError('M11_CRECE_TERMS_REQUIRED');
     throw error;
    }
    await c.query(
     'INSERT INTO tala_integration_v2.crece_founder_review_events '+
     '(application_id,decision,reviewer_id) VALUES($1::uuid,$2,$3::uuid)',
     [applicationId,input.decision,actorId]);
    return Object.freeze({applicationId,decision:input.decision,
     replayed:false,founderSeatGranted:input.decision==='approved'});
   });
  },
  /** Optional advertising contact is revocable without rewriting the
   * original signed terms. Owner M4/M6 + one-use M9 grants are mandatory.
   * A change writes one immutable M11 audit event with a unique operation.
   */
  updateMarketingPreference:async(input:{
   sessionToken:string;storeId:string;operationId:string;
   marketingOptIn:boolean
  })=>{
   configCheck(config);
   const storeId=validUuid(input.storeId);
   const operationId=validUuid(input.operationId);
   if(typeof input.marketingOptIn!=='boolean')
    throw new IntegrationError('M11_CRECE_MARKETING_VALUE_INVALID');
   const actorId=await authenticated(config,input.sessionToken,['merchant']);
   const store=await readStore(config.restaurantsPool,{actorId},storeId)
    .catch(()=>null);
   if(store?.store?.owner_id!==actorId)
    throw new IntegrationError('M11_CRECE_OWNER_REQUIRED');
   await grant(config,actorId,'crece.marketing.preference',storeId);
   return tx(config.integrationPool,async c=>{
    const row=await c.query<{
     application_id:string;m6_staff_actor_id:string
    }>(
     'SELECT application_id,m6_staff_actor_id '+
     'FROM tala_integration_v2.crece_founder_interest '+
     'WHERE m6_store_id=$1::uuid FOR UPDATE',[storeId]);
    const application=row.rows[0];
    if(!application)throw new IntegrationError('M11_CRECE_APPLICATION_NOT_FOUND');
    if(application.m6_staff_actor_id!==actorId)
     throw new IntegrationError('M11_CRECE_OWNER_REQUIRED');
    const previous=await c.query<{
     application_id:string;actor_id:string;opted_in:boolean
    }>(
     'SELECT application_id,actor_id,opted_in '+
     'FROM tala_integration_v2.crece_founder_marketing_events '+
     'WHERE operation_id=$1::uuid',[operationId]);
    if(previous.rows[0]){
     const prior=previous.rows[0];
     if(prior.application_id!==application.application_id||
        prior.actor_id!==actorId||prior.opted_in!==input.marketingOptIn)
      throw new IntegrationError('M11_CRECE_OPERATION_CONFLICT');
     return Object.freeze({marketingOptIn:prior.opted_in,replayed:true});
    }
    try{
     await c.query(
      'INSERT INTO tala_integration_v2.crece_founder_marketing_events '+
      '(application_id,operation_id,actor_id,opted_in) '+
      'VALUES($1::uuid,$2::uuid,$3::uuid,$4)',
      [application.application_id,operationId,actorId,input.marketingOptIn]);
    }catch(error){
     if(error&&typeof error==='object'&&'code' in error&&
        error.code==='23505')
      throw new IntegrationError('M11_CRECE_OPERATION_CONFLICT');
     throw error;
    }
    return Object.freeze({
     marketingOptIn:input.marketingOptIn,replayed:false
    });
   });
  },
  /** Owner sees its own real decision, never another store's application. */
  readMyStatus:async(input:{sessionToken:string;storeId:string})=>{
   configCheck(config);
   const storeId=validUuid(input.storeId);
   const subjectId=await authenticated(config,input.sessionToken,['merchant']);
   const store=await readStore(config.restaurantsPool,
    {actorId:subjectId},storeId).catch(()=>null);
   if(store?.store?.owner_id!==subjectId)
    throw new IntegrationError('M11_CRECE_OWNER_REQUIRED');
   return tx(config.integrationPool,async c=>{
    const data=await c.query<{
     application_id:string;decision:Decision|null;
     agreement_version:string|null;marketing_opt_in:boolean
    }>(
     'SELECT i.application_id,r.decision,i.agreement_version,'+
     'COALESCE((SELECT e.opted_in '+
     'FROM tala_integration_v2.crece_founder_marketing_events e '+
     'WHERE e.application_id=i.application_id '+
     'ORDER BY e.id DESC LIMIT 1),c.marketing_opt_in,false) '+
     'AS marketing_opt_in '+
     'FROM tala_integration_v2.crece_founder_interest i '+
     'LEFT JOIN tala_integration_v2.crece_founder_reviews r '+
     'ON r.application_id=i.application_id '+
     'LEFT JOIN tala_integration_v2.crece_founder_consents c '+
     'ON c.application_id=i.application_id '+
     'WHERE i.m6_store_id=$1::uuid',[storeId]);
    const row=data.rows[0];
    if(!row)return Object.freeze({
     status:'not_requested' as const,
     founderSeatGranted:false as const});
    return Object.freeze({status:row.decision??'interested',
     founderSeatGranted:row.decision==='approved',
     agreementVersion:row.agreement_version,
     marketingOptIn:row.marketing_opt_in});
   },true);
  }
 });
}
