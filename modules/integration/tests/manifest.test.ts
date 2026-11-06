import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {DOMAINS,ENTRYPOINTS,IntegrationError,loadManifest,
 assertManifest,verifyCheckoutRevisions} from '../src/manifest.js';

const requireSources=process.env.M11_REQUIRE_SOURCES==='1';
const dir=join(process.cwd(),'.upstream');
const manifestFile=join(process.cwd(),'upstreams.json');
test('M11 immutable manifest represents exactly ten nonduplicate owners',async()=>{
 const m=await loadManifest(manifestFile);
 assert.equal(m.integrationMode,'single-process-lab');
 assert.equal(m.sources.length,9);
 assert.equal(new Set(m.sources.flatMap(x=>x.includes)).size,10);
 assert.deepEqual(DOMAINS,[
  'orders','logistics','finance','users','notifications',
  'restaurants','locations','payments','security','analytics'
 ]);
 assert.equal(Object.keys(ENTRYPOINTS).length,10);
 assert.equal(ENTRYPOINTS.logistics.kind,'internal');
 assert.equal(ENTRYPOINTS.finance.kind,'internal');
 assert.equal(m.sources[0]?.includes.join(','),'M1,M2');
 assert.notEqual(m.sources[0]?.sha,m.sources[0]?.ancestorSha);
});
test('M11 rejects unpinned, tampered or duplicate source mappings',async()=>{
 const m=await loadManifest(manifestFile);
 const mutate=(f:(copy:Record<string,any>)=>void)=>{
  const copy=JSON.parse(JSON.stringify(m)) as Record<string,any>;
  f(copy);
  return copy;
 };
 const deny=(input:unknown,code:string)=>{
  assert.throws(()=>assertManifest(input),e=>
   e instanceof IntegrationError&&e.code===code);
 };
 deny(mutate(x=>{x.sources[2].sha='main';}),'M11_MANIFEST_INVALID');
 deny(mutate(x=>{x.sources[1].id='../other';}),'M11_MANIFEST_INVALID');
 deny(mutate(x=>{x.sources[5].includes=['M1'];}),'M11_DUPLICATE_MODULE');
 deny(mutate(x=>{x.sources[5].includes=['M11'];}),'M11_MANIFEST_INVALID');
 deny(mutate(x=>{x.sources=x.sources.slice(0,8);}),
  'M11_MANIFEST_INVALID');
 deny(mutate(x=>{x.repo='somewhere-else/repo';}),
  'M11_MANIFEST_INVALID');
 deny(mutate(x=>{x.sources[0].ancestorSha=x.sources[0].sha;}),
  'M11_M1_M2_DEPENDENCY_INVALID');
});
test('M11 checkout verification detects missing source repositories and incorrect SHAs',
 async()=>{
 const m=await loadManifest(manifestFile);
 await assert.rejects(verifyCheckoutRevisions('/tmp/m11-source-not-present',m),
  e=>e instanceof IntegrationError&&e.code==='M11_UPSTREAM_MISSING');
 if(!existsSync(dir)&&!requireSources)return;
 const revisions=await verifyCheckoutRevisions(dir,m);
 assert.equal(Object.keys(revisions).length,9);
 for(const src of m.sources)assert.equal(revisions[src.id],src.sha);
});
