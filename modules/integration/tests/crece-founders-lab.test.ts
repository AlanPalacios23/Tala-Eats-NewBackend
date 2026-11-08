import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {recordCreceInterestLab} from '../adapters/crece-founders-lab.js';
import {createStore} from '../../restaurants/src/stores.js';
import {IntegrationError} from '../src/events.js';

const integrationUrl=process.env.INTEGRATION_CI_URL??'';
const restaurantsUrl=process.env.RESTAURANTS_CI_URL??'';
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
  const first=await recordCreceInterestLab(config,{storeId,staffActorId,operationId});
  assert.equal(first.state,'interested');
  assert.equal(first.selectedForFounders,false);
  assert.equal(first.replayed,false);
  const repeated=await recordCreceInterestLab(config,{storeId,staffActorId,operationId});
  assert.equal(repeated.replayed,true);
  assert.equal(repeated.applicationId,first.applicationId);
  const r=await integrationPool.query<{
   n:string;slots:string;events:string
  }>("SELECT (SELECT count(*)::text FROM tala_integration_v2.crece_founder_interest "+
    "WHERE m6_store_id=$1::uuid) AS n, "+
    "(SELECT count(*)::text FROM tala_integration_v2.crece_founder_interest "+
    "WHERE m6_store_id=$1::uuid AND selected_for_founders=true) AS slots, "+
    "(SELECT count(*)::text FROM tala_integration_v2.crece_founder_interest_events "+
    "WHERE application_id=$2::uuid) AS events",[storeId,first.applicationId]);
  assert.deepEqual(r.rows[0],{n:'1',slots:'0',events:'1'});
  await assert.rejects(
   recordCreceInterestLab(config,{storeId,staffActorId,operationId:randomUUID()}),
   (e:unknown)=>e instanceof IntegrationError&&e.code==='M11_CRECE_ALREADY_REQUESTED');
  await assert.rejects(
   recordCreceInterestLab(config,{storeId,staffActorId:randomUUID(),operationId:randomUUID()})
  );
  process.env.NODE_ENV='production';
  await assert.rejects(
   recordCreceInterestLab(config,{storeId,staffActorId,operationId}),
   (e:unknown)=>e instanceof IntegrationError&&e.code==='M11_CRECE_COMMERCIAL_DISABLED');
 }finally{
  if(originalRuntime===undefined)delete process.env.CORE_V2_INTEGRATION_RUNTIME;
  else process.env.CORE_V2_INTEGRATION_RUNTIME=originalRuntime;
  if(originalNode===undefined)delete process.env.NODE_ENV;
  else process.env.NODE_ENV=originalNode;
  await Promise.all([integrationPool.end(),restaurantsPool.end()]);
 }
});
