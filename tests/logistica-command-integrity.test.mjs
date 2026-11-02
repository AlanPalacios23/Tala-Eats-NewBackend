import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {reserveFingerprint,rerouteFingerprint,finalizeFingerprint}
 from '../src/modules/modulo-2-logistica/command-integrity.ts';
const id='00000000-0000-4000-8000-000000000001';
const merchant='00000000-0000-4000-8000-000000000002';
const pt={latitude:20.653,longitude:-103.699};
test('HMAC: same input and secret stable, small change gives different MAC',()=>{
 const a=reserveFingerprint(id,merchant,'tala','proximity',pt,20000);
 assert.match(a,/^[a-f0-9]{64}$/);
 assert.equal(a,reserveFingerprint(id,merchant,'tala','proximity',pt,20000));
 assert.notEqual(a,reserveFingerprint(id,merchant,'tala','proximity',pt,19000));
 assert.notEqual(a,reserveFingerprint(id,merchant,'tala','proximity',
  {...pt,latitude:20.654},20000));
 assert.notEqual(rerouteFingerprint(id,'1',pt,20000),
  rerouteFingerprint(id,'2',pt,20000));
 assert.notEqual(finalizeFingerprint(id,'1','released'),
  finalizeFingerprint(id,'1','completed'));
});
test('HMAC: fails closed without a configured secret or with weak key',()=>{
 const script=[
  "import {reserveFingerprint} from './src/modules/modulo-2-logistica/command-integrity.ts'",
  "reserveFingerprint('00000000-0000-4000-8000-000000000001',",
  "'00000000-0000-4000-8000-000000000002','tala','capacity')"
 ].join(';').replace(';reserveFingerprint', '\nreserveFingerprint')
   .replace(';\'00000000','\'00000000');
 // The separate process proves that a missing secret cannot silently fall back.
 const env={...process.env};
 delete env.TALA_DISPATCH_HMAC_KEY;
 const r=spawnSync(process.execPath,['--experimental-strip-types',
  '--input-type=module','-e',script],{env,encoding:'utf8',timeout:10000});
 assert.notEqual(r.status,0);
 assert.match(r.stderr,/LOGISTICS_HMAC_KEY_REQUIRED/);
 const short=spawnSync(process.execPath,['--experimental-strip-types',
  '--input-type=module','-e',script],{
   env:{...env,TALA_DISPATCH_HMAC_KEY:'weak'},encoding:'utf8',timeout:10000
  });
 assert.notEqual(short.status,0);
 assert.match(short.stderr,/LOGISTICS_HMAC_KEY_REQUIRED/);
});
