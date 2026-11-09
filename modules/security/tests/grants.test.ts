import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {ACTIONS,SecurityError,signHostGrant,verifyHostGrant,
 type HostGrant,type KeyRing,type SecurityAction} from '../src/grants.js';
const keyring:KeyRing={rot01:randomBytes(32),rot02:randomBytes(32)};
const id=()=>randomUUID();
const now=()=>Math.floor(Date.now()/1000);
function sample(change:Partial<HostGrant>={}):HostGrant{
 const n=now();
 return {version:1,issuer:'tala-trusted-gateway-lab',
  audience:'m9-security-lab',grantId:id(),subjectId:id(),resourceId:id(),
  action:'orders.cancel',assurance:'session',assuranceAt:null,
  issuedAt:n-1,expiresAt:n+90,...change};
}
function err(work:()=>unknown,code:string){
 assert.throws(work,e=>e instanceof SecurityError&&e.code===code);
}
test('M9 LAB key IDs rotate and signed grants are exact action/resource-bound',()=>{
 const g=sample();
 const token=signHostGrant(g,'rot01',keyring);
 assert.deepEqual(verifyHostGrant(token,keyring),g);
 assert.deepEqual(verifyHostGrant(signHostGrant(g,'rot02',keyring),keyring),g);
 err(()=>verifyHostGrant(token,{rot02:keyring.rot02!}), 'M9_GRANT_INVALID');
 const parts=token.split('.');
 const changed=[...parts];changed[2]=Buffer.from(JSON.stringify({...g,
  action:'payments.refund.request'})).toString('base64url');
 err(()=>verifyHostGrant(changed.join('.'),keyring),'M9_GRANT_INVALID');
 err(()=>verifyHostGrant('Bearer '+token,keyring),'M9_GRANT_INVALID');
 err(()=>verifyHostGrant(token,keyring,(g.expiresAt+2)*1000),
  'M9_GRANT_EXPIRED');
});
test('M9 LAB rejects hostile schema, expiry, unknown scope and improperly issued grants',()=>{
 const g=sample();
 err(()=>signHostGrant({...g,action:'unknown' as SecurityAction},
   'rot01',keyring),'M9_GRANT_INVALID');
 err(()=>signHostGrant({...g,expiresAt:g.issuedAt+121},
   'rot01',keyring),'M9_GRANT_INVALID');
 err(()=>signHostGrant({...g,assurance:'session',assuranceAt:now()-2},
   'rot01',keyring),'M9_GRANT_INVALID');
 err(()=>signHostGrant({...g,issuedAt:now()+60,expiresAt:now()+90},
   'rot01',keyring),'M9_GRANT_EXPIRED');
 err(()=>signHostGrant({...g,audience:'other' as HostGrant['audience']},
   'rot01',keyring),'M9_GRANT_INVALID');
 err(()=>signHostGrant(g,'rot01',{rot01:randomBytes(8)}),'M9_KEY_INVALID');
 assert.equal(Object.keys(ACTIONS).length,10);
 assert.deepEqual(ACTIONS['crece.marketing.preference'],{limit:60,stepUp:false});
 assert.deepEqual(ACTIONS['crece.interest.submit'],{limit:6,stepUp:false});
 assert.deepEqual(ACTIONS['crece.founder.review'],{limit:15,stepUp:false});
 assert.deepEqual(ACTIONS['crece.founder.list'],{limit:40,stepUp:false});
});
test('M9 LAB strict grant length, signatures, noncanonical payload and duplicate keys',()=>{
 const g=sample();
 const t=signHostGrant(g,'rot01',keyring);
 err(()=>verifyHostGrant(t+'x',keyring),'M9_GRANT_INVALID');
 err(()=>verifyHostGrant('v1.rot01.'+'A'.repeat(4000)+'.'+'A'.repeat(43),
   keyring),'M9_GRANT_INVALID');
 err(()=>verifyHostGrant(t.replace('rot01','rot99'),keyring),
   'M9_GRANT_INVALID');
 err(()=>verifyHostGrant(t.replace('v1.','v2.'),keyring),
   'M9_GRANT_INVALID');
 // A 32-byte SHA-256 signature has two unused bits in its last base64url
 // character; noncanonical encodings must not be accepted as aliases.
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
 const index=alphabet.indexOf(t.at(-1)!);
 assert.equal(index%4,0);
 const alias=t.slice(0,-1)+alphabet[index+1]!;
 err(()=>verifyHostGrant(alias,keyring),'M9_GRANT_INVALID');
});
