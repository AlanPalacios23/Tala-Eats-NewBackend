import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validatePreproductionGateManifest,REQUIRED_GATES}
 from '../scripts/verify-core-v2-preprod.mjs';
const valid=JSON.parse(await readFile(
 new URL('../release/core-v2-rc3-gates.json',import.meta.url),'utf8'));
const clone=()=>structuredClone(valid);
test('RC3 cannot claim production readiness based on LAB success',()=>{
 const state=validatePreproductionGateManifest(valid);
 assert.equal(state.productionReady,false);
 assert.equal(state.commercialActivation,false);
 assert.equal(state.safeToDeployLive,false);
 assert.equal(state.decision,'NO_GO');
 assert.deepEqual(state.pending,REQUIRED_GATES);
});
test('RC3 blocks malformed, duplicated or missing gates',()=>{
 const duplicate=clone();
 duplicate.gateEvidence[1].id='G1';
 assert.throws(()=>validatePreproductionGateManifest(duplicate),
  /RC3_GATE_INVALID:GATE_ID_INVALID/);
 const missing=clone();missing.gateEvidence.pop();
 assert.throws(()=>validatePreproductionGateManifest(missing),
  /RC3_GATE_INVALID:GATE_COUNT_MISMATCH/);
 const selfApproved=clone();selfApproved.gateEvidence[2].status='passed';
 assert.throws(()=>validatePreproductionGateManifest(selfApproved),
  /RC3_GATE_INVALID:GATE_MISSING_OR_FALSE_CLAIM/);
});
test('RC3 rejects self-enable, fake approval or financial regressions',()=>{
 for(const [field,value] of [
  ['commercialActivation',true],
  ['commercialActivation','true'],
  ['environment','production']
 ]){
  const bad=clone();bad[field]=value;
  assert.throws(()=>validatePreproductionGateManifest(bad),/RC3_GATE_INVALID/);
 }
 const fake=clone();fake.releaseApproval.approved=true;
 assert.throws(()=>validatePreproductionGateManifest(fake),
  /RC3_GATE_INVALID:COMMERCIAL_ACTIVATION_FORBIDDEN/);
 for(const [key,value] of [
  ['merchantCommissionBps',1500],['customerServiceBps',7000],
  ['serviceFeeCapMinor',2500],['tipCommissionBps',100]
 ]){
  const bad=clone();bad.commercialPolicy[key]=value;
  assert.throws(()=>validatePreproductionGateManifest(bad),
   /RC3_GATE_INVALID:COMMERCIAL_POLICY_MISMATCH/);
 }
});
test('RC3 requires explicit auditable blockers and restricted evidence URLs',()=>{
 const noReason=clone();noReason.gateEvidence[0].blocker='';
 assert.throws(()=>validatePreproductionGateManifest(noReason),/RC3_GATE_INVALID/);
 const fakeEvidence=clone();
 fakeEvidence.gateEvidence[0].evidenceLinks=['http://localhost:1234/fake'];
 assert.throws(()=>validatePreproductionGateManifest(fakeEvidence),/RC3_GATE_INVALID/);
});
