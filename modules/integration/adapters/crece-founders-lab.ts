/** Tala Eats Crece — M11 internal LAB interest queue.
 * No public HTTP routes, no owner onboarding shortcut, no automatic
 * discounts/commissions/founder places/marketing entitlements.
 * M4/M9 commercial gateway is NOT ready; this adapter must never be
 * reachable from customer-facing apps until issuer & resource gates pass.
 */
import type {Pool} from 'pg';
import {readStore} from '../../restaurants/src/stores.js';
import {IntegrationError,validUuid} from '../src/events.js';

type Config={integrationPool:Pool;restaurantsPool:Pool};
type InterestRow={
 application_id:string;m6_store_id:string;m6_staff_actor_id:string;
 operation_id:string;state:'interested';selected_for_founders:false;
 agreement_version:string|null;marketing_opt_in:boolean;
};
export type CreceInterest={applicationId:string;state:'interested';
 selectedForFounders:false;replayed:boolean};
const getDatabase=async(pool:Pool)=>(
 await pool.query<{name:string}>('SELECT current_database() AS name')
).rows[0]?.name;
function requireLab(){
 if(process.env.NODE_ENV==='production' ||
   process.env.CORE_V2_INTEGRATION_RUNTIME!=='isolated-lab' ||
   process.env.CORE_V2_INTEGRATION_PUBLIC_HTTP_ENABLED==='true')
  throw new IntegrationError('M11_CRECE_COMMERCIAL_DISABLED');
}
/** Internal host only. Actor must come from a separately authenticated host
 * in future; real M6 SQL staff access is checked here. No client-supplied
 * actor is ever acceptable for an HTTP adapter.
 */
export async function recordCreceInterestLab(config:Config,raw:{
 storeId:string;staffActorId:string;operationId:string;
 termsAccepted:true;termsVersion:string;marketingOptIn:boolean;
}):Promise<CreceInterest>{
 requireLab();
 if(!config?.integrationPool||!config?.restaurantsPool)
  throw new IntegrationError('M11_CRECE_CONFIG_INVALID');
 const storeId=validUuid(raw?.storeId),
  actorId=validUuid(raw?.staffActorId),
  operationId=validUuid(raw?.operationId);
 if(raw?.termsAccepted!==true||
  raw.termsVersion!=='crece-founder-pilot-2026-11-v1'||
  typeof raw.marketingOptIn!=='boolean')
  throw new IntegrationError('M11_CRECE_EXPLICIT_TERMS_REQUIRED');
 if(await getDatabase(config.integrationPool)!=='tala_integration_v2_test'||
   await getDatabase(config.restaurantsPool)!=='tala_restaurants_v2_test')
  throw new IntegrationError('M11_CRECE_LAB_ONLY');
 // Only the genuine M6 owner can express interest in commercial terms.
 // An editor or manager must not be able to bind a business to this program.
 const store=await readStore(config.restaurantsPool,{actorId},storeId);
 if(!store?.store||store.store.id!==storeId)
  throw new IntegrationError('M11_CRECE_STORE_UNVERIFIED');
 if(store.store.owner_id!==actorId)
  throw new IntegrationError('M11_CRECE_OWNER_REQUIRED');
 const client=await config.integrationPool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout='12000ms'");
  await client.query("SET LOCAL lock_timeout='3000ms'");
  // A row lock cannot protect a missing row. Serialize concurrent first
  // submissions for one store BEFORE SELECT to preserve idempotent replay.
  await client.query(
   'SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',
   ['crece-founder-interest:'+storeId]);
  const current=await client.query<InterestRow>(
   'SELECT application_id,m6_store_id,m6_staff_actor_id,operation_id,state,'+
   'selected_for_founders,agreement_version,marketing_opt_in '+
   'FROM tala_integration_v2.crece_founder_interest '+
   'WHERE m6_store_id=$1::uuid FOR UPDATE',[storeId]);
  const prev=current.rows[0];
  if(prev){
   if(prev.operation_id!==operationId||prev.m6_staff_actor_id!==actorId||
      prev.agreement_version!==raw.termsVersion||
      prev.marketing_opt_in!==raw.marketingOptIn)
    throw new IntegrationError('M11_CRECE_ALREADY_REQUESTED');
   await client.query('COMMIT');
   return {applicationId:prev.application_id,state:'interested',
    selectedForFounders:false,replayed:true};
  }
  const created=await client.query<InterestRow>(
   'INSERT INTO tala_integration_v2.crece_founder_interest '+
   '(m6_store_id,m6_staff_actor_id,operation_id,agreement_version,'+
   'agreement_accepted_at,marketing_opt_in) '+
   'VALUES($1::uuid,$2::uuid,$3::uuid,$4,clock_timestamp(),$5) '+
   'RETURNING application_id,m6_store_id,m6_staff_actor_id,operation_id,state,'+
   'selected_for_founders,agreement_version,marketing_opt_in',
   [storeId,actorId,operationId,raw.termsVersion,raw.marketingOptIn]);
  const row=created.rows[0];
  if(!row||row.selected_for_founders)
   throw new IntegrationError('M11_CRECE_INSERT_INVALID');
  await client.query(
   'INSERT INTO tala_integration_v2.crece_founder_consents '+
   '(application_id,agreement_version,marketing_opt_in) '+
   'VALUES($1::uuid,$2,$3)',[row.application_id,raw.termsVersion,
    raw.marketingOptIn]);
  await client.query(
   'INSERT INTO tala_integration_v2.crece_founder_interest_events '+
   '(application_id) VALUES($1::uuid)',[row.application_id]);
  await client.query('COMMIT');
  return {applicationId:row.application_id,state:'interested',
   selectedForFounders:false,replayed:false};
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  if(error&&typeof error==='object'&&'code' in error&&error.code==='23505')
   throw new IntegrationError('M11_CRECE_ALREADY_REQUESTED');
  throw error;
 }finally{client.release();}
}
