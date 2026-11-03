import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  UsersError,canonicalEmail,canonicalDisplayName,requireUserId,
  requireIdempotencyKey,eventFingerprint,nextUserStatus,assertVersion
} from '../src/domain.js';

const reject=(fn:()=>unknown,code:string)=>{
  assert.throws(fn,(error:unknown)=>error instanceof UsersError&&error.code===code);
};
test('M4 emails normalized without unsafe Unicode, ambiguous syntax or mailbox aliasing',()=>{
  assert.equal(canonicalEmail('  Usu.Ario+Prueba@Example.COM '),
    'usu.ario+prueba@example.com');
  for(const email of [
    'a@x.c','two@@example.com','a..b@example.com','.a@example.com',
    'a.@example.com','a@-example.com','a@example..com',
    'prueba@localhost','prueba@example.invalid','a b@example.com',
    'á@example.com',42,null,''
  ])reject(()=>canonicalEmail(email),'USERS_EMAIL_INVALID');
});
test('M4 display name supports Mexican accents, rejects markup/control characters',()=>{
  assert.equal(canonicalDisplayName('  María   José  '),'María José');
  assert.equal(canonicalDisplayName('José Pérez'),'José Pérez');
  for(const name of ['<script>','A','A\nB','😀😀','A'.repeat(81),null]){
    reject(()=>canonicalDisplayName(name),'USERS_NAME_INVALID');
  }
});
test('M4 UUID canonicalization and command key constraints',()=>{
  const id=randomUUID();
  assert.equal(requireUserId(id.toUpperCase()),id);
  reject(()=>requireUserId('person-1'),'USERS_ID_INVALID');
  reject(()=>requireIdempotencyKey('short'),'USERS_COMMAND_INVALID');
  const key='m4-register-idempotent-01234567';
  assert.equal(eventFingerprint(key,'register_pending'),
    eventFingerprint(key,'register_pending'));
  assert.notEqual(eventFingerprint(key,'register_pending'),
    eventFingerprint(key,'transition'));
});
test('M4 account transitions are explicit, deny all unsupported escalations',()=>{
  assert.equal(nextUserStatus('pending_verification','email_verified'),'active');
  assert.equal(nextUserStatus('active','suspend'),'suspended');
  assert.equal(nextUserStatus('suspended','reinstate'),'active');
  assert.equal(nextUserStatus('active','request_deletion'),'deletion_requested');
  assert.equal(nextUserStatus('deletion_requested','finalize_deletion'),'deleted');
  reject(()=>nextUserStatus('deleted','reinstate'),'USERS_STATE_TRANSITION_DENIED');
  reject(()=>nextUserStatus('pending_verification','reinstate'),'USERS_STATE_TRANSITION_DENIED');
  reject(()=>nextUserStatus('pending_verification','suspend'),'USERS_STATE_TRANSITION_DENIED');
  reject(()=>nextUserStatus('suspended','email_verified'),'USERS_STATE_TRANSITION_DENIED');
});
test('M4 optimistic account versions must be safe positive integers',()=>{
  for(const value of [0,1.5,NaN,Infinity,-1,2_147_483_647,'2',null]){
    reject(()=>assertVersion(value),'USERS_VERSION_INVALID');
  }
  assert.equal(assertVersion(4),4);
});
