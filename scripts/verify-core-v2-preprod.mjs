/** Preproduction release guard (READ ONLY). NOT a deployment approval.
 * A future candidate requires a new, independently audited release process.
 * This guard intentionally cannot be flipped to GO via a JSON/environment flag.
 */
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const REQUIRED_GATES=Object.freeze(
 Array.from({length:9},(_,i)=>'G'+(i+1))
);
const deny=(message)=>{throw new Error('RC3_GATE_INVALID:'+message);};
export function validatePreproductionGateManifest(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))
  deny('OBJECT_REQUIRED');
 if(raw.schemaVersion!==1||raw.release!=='core-v2-rc3-canonical-preprod'||
    raw.environment!=='preproduction-lab')deny('RELEASE_IDENTITY_INVALID');
 if(raw.commercialActivation!==false||raw.releaseApproval?.approved!==false||
    raw.releaseApproval?.approvedCommit!==null)
  deny('COMMERCIAL_ACTIVATION_FORBIDDEN');
 const p=raw.commercialPolicy;
 if(!p||p.merchantCommissionBps!==1700||p.customerServiceBps!==700||
    p.serviceFeeCapMinor!==null||p.tipCommissionBps!==0||
    p.policyVersion!=='pilot-2026-11-v3-17pct-7pct-uncapped')
  deny('COMMERCIAL_POLICY_MISMATCH');
 if(!Array.isArray(raw.gateEvidence)||raw.gateEvidence.length!==9)
  deny('GATE_COUNT_MISMATCH');
 const ids=new Set();
 for(const gate of raw.gateEvidence){
  if(!gate||!REQUIRED_GATES.includes(gate.id)||ids.has(gate.id))
   deny('GATE_ID_INVALID');
  ids.add(gate.id);
  if(!['partial','blocked'].includes(gate.status)||
     typeof gate.blocker!=='string'||gate.blocker.trim().length<30||
     !Array.isArray(gate.evidenceLinks)||
     gate.evidenceLinks.some(url=>typeof url!=='string'||
       !/^https:\/\/github\.com\/AlanPalacios23\/Tala-Eats-NewBackend\//.test(url)))
   deny('GATE_MISSING_OR_FALSE_CLAIM');
 }
 if(REQUIRED_GATES.some(gate=>!ids.has(gate)))deny('GATE_MISSING');
 return Object.freeze({
  release:raw.release,productionReady:false,commercialActivation:false,
  decision:'NO_GO',pending:[...REQUIRED_GATES],
  reason:'G1-G9_REQUIRE_INDEPENDENT_EVIDENCE_AND_HUMAN_APPROVAL',
  safeToDeployLive:false
 });
}
async function main(){
 const path=resolve(process.argv[2]||'release/core-v2-rc3-gates.json');
 const config=JSON.parse(await readFile(path,'utf8'));
 process.stdout.write(JSON.stringify(
  validatePreproductionGateManifest(config),null,2)+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
}
