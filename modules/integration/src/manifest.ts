/** M11 integration: immutable, verified source map for ten independently owned domains.
 * M1 and M2 are sourced from the same M2 descendant checkout to avoid
 * loading a second, incompatible Orders class at runtime.
 */
import {readFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export class IntegrationError extends Error{
 constructor(readonly code:string){super(code);this.name='IntegrationError';}
}
export const DOMAINS=['orders','logistics','finance','users','notifications',
 'restaurants','locations','payments','security','analytics'] as const;
export type Domain=typeof DOMAINS[number];
export type Upstream={
 id:string,sha:string,branch:string,includes:string[],ancestorSha?:string
};
export type Manifest={schemaVersion:number,repo:string,
 integrationMode:string,sources:Upstream[]};
const allowedSourceNames=['orders-logistics','finance','users',
 'notifications','restaurants','locations','payments','security','analytics'];
const expectedOwners=['M1','M2','M3','M4','M5','M6','M7','M8','M9','M10'];
const sha=/^[0-9a-f]{40}$/;
const safeId=/^[a-z][a-z-]{2,31}$/;
const run=promisify(execFile);
export function assertManifest(raw:unknown):Manifest{
 if(raw===null||typeof raw!=='object'||Array.isArray(raw))
  throw new IntegrationError('M11_MANIFEST_INVALID');
 const m=raw as Record<string,unknown>;
 if(m.schemaVersion!==1||m.repo!=='AlanPalacios23/Tala-Eats-NewBackend'||
  m.integrationMode!=='single-process-lab'||!Array.isArray(m.sources)||
  m.sources.length!==9)
  throw new IntegrationError('M11_MANIFEST_INVALID');
 const sources=m.sources as Upstream[];
 const ids=new Set<string>(),owners=new Set<string>();
 for(const src of sources){
  if(!src||typeof src!=='object'||typeof src.id!=='string'||
    !safeId.test(src.id)||!allowedSourceNames.includes(src.id)||
    typeof src.sha!=='string'||!sha.test(src.sha)||
    typeof src.branch!=='string'||!src.branch.startsWith('feat/core-v2-')||
    !Array.isArray(src.includes)||src.includes.length<1||
    src.includes.some(x=>typeof x!=='string'||!expectedOwners.includes(x))||
    ids.has(src.id))
   throw new IntegrationError('M11_MANIFEST_INVALID');
  ids.add(src.id);
  for(const owner of src.includes){
   if(owners.has(owner))throw new IntegrationError('M11_DUPLICATE_MODULE');
   owners.add(owner);
  }
 }
 if(allowedSourceNames.some(name=>!ids.has(name))||
  expectedOwners.some(owner=>!owners.has(owner)))
  throw new IntegrationError('M11_MODULE_MISSING');
 const joined=sources.find(x=>x.id==='orders-logistics');
 if(joined?.includes.join(',')!=='M1,M2'||!joined.ancestorSha||
  !sha.test(joined.ancestorSha)||joined.ancestorSha===joined.sha||
  sources.some(x=>x.id!=='orders-logistics'&&x.ancestorSha!==undefined))
  throw new IntegrationError('M11_M1_M2_DEPENDENCY_INVALID');
 return m as Manifest;
}
export async function loadManifest(file:string):Promise<Manifest>{
 let text:string;
 try{text=await readFile(file,'utf8')}catch{
  throw new IntegrationError('M11_MANIFEST_NOT_FOUND');
 }
 try{return assertManifest(JSON.parse(text))}catch(e){
  if(e instanceof IntegrationError)throw e;
  throw new IntegrationError('M11_MANIFEST_INVALID');
 }
}
export async function verifyCheckoutRevisions(root:string,manifest:Manifest){
 const absolute=resolve(root);
 const result:Record<string,string>={};
 for(const source of manifest.sources){
  const path=join(absolute,source.id);
  try{
   if(!(await stat(path)).isDirectory())
    throw new IntegrationError('M11_UPSTREAM_MISSING');
   const git=await run('git',['-C',path,'rev-parse','HEAD'],{
    timeout:8000,maxBuffer:65536});
   const actual=git.stdout.trim();
   if(actual!==source.sha)
    throw new IntegrationError('M11_UPSTREAM_SHA_MISMATCH');
   result[source.id]=actual;
  }catch(e){
   if(e instanceof IntegrationError)throw e;
   throw new IntegrationError('M11_UPSTREAM_MISSING');
  }
 }
 const joined=manifest.sources.find(x=>x.id==='orders-logistics')!;
 try{
  await run('git',['-C',join(absolute,joined.id),
   'merge-base','--is-ancestor',joined.ancestorSha!,joined.sha],{
   timeout:8000,maxBuffer:65536});
 }catch{throw new IntegrationError('M11_M1_NOT_ANCESTOR_OF_M2');}
 return Object.freeze(result);
}
export const ENTRYPOINTS:Readonly<Record<Domain,{
 source:string,file:string,exportName:string,kind:'http'|'internal'
}>>={
 orders:{source:'orders-logistics',file:'src/modules/orders/lab-http.ts',
  exportName:'createOrderApp',kind:'http'},
 logistics:{source:'orders-logistics',file:'src/modules/logistics/tala-dispatch-engine.ts',
  exportName:'expireDispatchOffers',kind:'internal'},
 finance:{source:'finance',file:'modules/finance/src/store.mjs',
  exportName:'recordLabHeldAllocation',kind:'internal'},
 users:{source:'users',file:'modules/users/src/http-lab.ts',
  exportName:'createUsersLabHttpServer',kind:'http'},
 notifications:{source:'notifications',file:'modules/notifications/src/http-lab.ts',
  exportName:'createNotificationsLabHttpServer',kind:'http'},
 restaurants:{source:'restaurants',file:'modules/restaurants/src/http-lab.ts',
  exportName:'createRestaurantsLabHttpServer',kind:'http'},
 locations:{source:'locations',file:'modules/locations/src/http-lab.ts',
  exportName:'createLocationsLabHttpServer',kind:'http'},
 payments:{source:'payments',file:'modules/payments/src/http-lab.ts',
  exportName:'createPaymentsLabHttpServer',kind:'http'},
 security:{source:'security',file:'modules/security/src/http-lab.ts',
  exportName:'createSecurityLabHttpServer',kind:'http'},
 analytics:{source:'analytics',file:'modules/analytics/src/http-lab.ts',
  exportName:'createAnalyticsLabHttpServer',kind:'http'}
};
