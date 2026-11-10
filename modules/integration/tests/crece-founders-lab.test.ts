import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {recordCreceInterestLab} from '../adapters/crece-founders-lab.js';
import {createStore,setStaffRole} from '../../restaurants/src/stores.js';
import {IntegrationError} from '../src/events.js';

const integrationUrl=process.env.INTEGRATION_CI_URL??'';
const restaurantsUrl=process.env.RESTAURANTS_CI_URL??'';
const terms={termsAccepted:true as const,termsVersion:'crece-founder-pilot-2026-11-v1',marketingOptIn:false};
const enabled=integrationUrl.includes('/tala_integration_v2_test')&&
 restaurantsUrl.includes('/tala_restaurants_v2_test');

test('Crece founder interest: real M6 owner, durable M11 record, replay and no automatic enrollment',
 {skip:!enabled,timeout:60000},async()=>{
 const integrationPool=new pg.Pool({connectionString:integrationUrl});
 const restaurantsPool=new pg.Pool({connectionString:restaurantsUrl});
 const originalRuntime=process.env.CORE_V2_INTEGRATION_RUNTIME;
 const originalNode=process.env.NODE_ENV;
 process.env.CORE_V2_INTEGRATION_RUNTIME='isolated-lab';
 process.env.NODE_ENV='test';
 try{
  const staffActorId=randomUUID();
  const newStore=await createStore(restaurantsPool,{actorId:staffActorId},{
   operationId:randomUUID(),slug:'crece-'+randomUUID().slice(0,12),
   name:'Crece piloto',kind:'restaurant'
  });
  const storeId=newStore.id,operationId=randomUUID();
  const config={integrationPool,restaurantsPool};
  const first=await recordCreceInterestLab(config,{storeId,staffActorId,operationId,...terms});
  assert.equal(first.state,'interested');
  assert.equal(first.selectedForFounders,false);
  assert.equal(first.replayed,false);
  const consent=await integrationPool.query<{agreement_version:string,marketing_opt_in:boolean}>(
   'SELECT agreement_version,marketing_opt_in FROM tala_integration_v2.crece_founder_consents WHERE application_id=$1::uuid',
   [first.applicationId]);
  assert.deepEqual(consent.rows[0],{
   agreement_version:'crece-founder-pilot-2026-11-v1',
   marketing_opt_in:false
  });
  const repeated=await recordCreceInterestLab(config,{storeId,staffActorId,operationId,...terms});
  assert.equal(repeated.replayed,true);
  assert.equal(repeated.applicationId,first.applicationId);
  // Multiple concurrent retries must all resolve to the same receipt,
  // without leaking a unique-constraint error or duplicating events.
  const concurrent=await Promise.all(Array.from({length:12},()=>
   recordCreceInterestLab(config,{storeId,staffActorId,operationId,...terms})));
  assert.ok(concurrent.every(x=>x.replayed&&x.applicationId===first.applicationId));
  const editor=randomUUID();
  await setStaffRole(restaurantsPool,{actorId:staffActorId},{
   storeId,memberId:editor,role:'editor'
  });
  await assert.rejects(
   recordCreceInterestLab(config,{
    storeId,staffActorId:editor,operationId:randomUUID(),...terms
   }),
   (e:unknown)=>e instanceof IntegrationError&&
    e.code==='M11_CRECE_OWNER_REQUIRED'
  );
  const r=await integrationPool.query<{
   n:string;slots:string;events:string
  }>("SELECT (SELECT count(*)::text FROM tala_integration_v2.crece_founder_interest "+
    "WHERE m6_store_id=$1::uuid) AS n, "+
    "(SELECT count(*)::text FROM tala_integration_v2.crece_founder_interest "+
    "WHERE m6_store_id=$1::uuid AND selected_for_founders=true) AS slots, "+
    "(SELECT count(*)::text FROM tala_integration_v2.crece_founder_interest_events "+
    "WHERE application_id=$2::uuid) AS events",[storeId,first.applicationId]);
  assert.deepEqual(r.rows[0],{n:'1',slots:'0',events:'1'});
  await assert.rejects(integrationPool.query(
   'UPDATE tala_integration_v2.crece_founder_interest_events '+
   'SET event_type=event_type WHERE application_id=$1::uuid',
   [first.applicationId]
  ));
  await assert.rejects(
   recordCreceInterestLab(config,{storeId,staffActorId,operationId:randomUUID(),...terms}),
   (e:unknown)=>e instanceof IntegrationError&&e.code==='M11_CRECE_ALREADY_REQUESTED');
  await assert.rejects(
   recordCreceInterestLab(config,{storeId,staffActorId:randomUUID(),operationId:randomUUID(),...terms})
  );
  process.env.NODE_ENV='production';
  await assert.rejects(
   recordCreceInterestLab(config,{storeId,staffActorId,operationId,...terms}),
   (e:unknown)=>e instanceof IntegrationError&&e.code==='M11_CRECE_COMMERCIAL_DISABLED');
 }finally{
  if(originalRuntime===undefined)delete process.env.CORE_V2_INTEGRATION_RUNTIME;
  else process.env.CORE_V2_INTEGRATION_RUNTIME=originalRuntime;
  if(originalNode===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=originalNode;
  await Promise.all([integrationPool.end(),restaurantsPool.end()]);
 }
});
