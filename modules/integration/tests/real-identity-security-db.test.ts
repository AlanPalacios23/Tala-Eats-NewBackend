import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createIdentitySecurityLabGate} from '../adapters/identity-security-lab.js';
import {IntegrationError} from '../src/events.js';
import {registerCredentialedPendingUser,loginLabUser,logoutLabSession}
 from '../../users/src/auth.js';
import {issueLabEmailChallenge,verifyLabEmailChallenge}
 from '../../users/src/store.js';
import type {SecurityConfig} from '../../security/src/gate.js';

const usersUrl=process.env.USERS_CI_URL??'';
const securityUrl=process.env.SECURITY_CI_URL??'';
const enabled=usersUrl.includes('/tala_users_v2_test')&&
 securityUrl.includes('/tala_security_v2_test');
const id=()=>randomUUID();
const errorCode=(error:unknown,code:string)=>error instanceof IntegrationError&&
 error.code===code;
const password='TalaM11-Lab#2026Clave Segura';
async function activeLabUser(pool:pg.Pool,secret:Buffer,mailSecret:Buffer){
 const email='m11.'+id()+'@example.test';
 const created=await registerCredentialedPendingUser(pool,{
  email,displayName:'Prueba M11 Usuario',password,secret,idempotencyKey:id()
 });
 const proof=await issueLabEmailChallenge(pool,{
  userId:created.user.id,secret:mailSecret
 });
 await verifyLabEmailChallenge(pool,{
  userId:created.user.id,actorId:created.user.id,
  token:proof.token,secret:mailSecret,expectedVersion:1,
  idempotencyKey:id()
 });
 const login=await loginLabUser(pool,{email,password,secret});
 return {id:created.user.id,login};
}
test('M11 real M4 + M9: valid session and resource proof enable one scoped lab authorization',
 {skip:!enabled,timeout:120000},async()=>{
 const usersPool=new pg.Pool({connectionString:usersUrl,max:12});
 const securityPool=new pg.Pool({connectionString:securityUrl,max:12});
 const pepper=randomBytes(32),mailSecret=randomBytes(32);
 const security:SecurityConfig={
  pool:securityPool,
  keyring:{gate01:randomBytes(32)},
  pseudonymKey:randomBytes(32)
 };
 try{
  const actor=await activeLabUser(usersPool,pepper,mailSecret);
  const ownedOrder=id(),otherOrder=id();
  let checkedOwnership=0;
  const gate=createIdentitySecurityLabGate({
   usersPool,usersPasswordPepper:pepper,security,grantKeyId:'gate01',
   verifyOwnershipFromHost:async ({subjectId,orderId})=>{
    checkedOwnership++;
    return subjectId===actor.id&&orderId===ownedOrder?
     {subjectId,resourceId:orderId,allowed:true,
      evidenceSource:'trusted_lab_host'}:null;
   }
  });
  const permit=await gate.authorizeLabOrderCancel({
   sessionToken:actor.login.sessionToken,orderId:ownedOrder
  });
  assert.equal(permit.authorized,true);
  assert.equal(permit.action,'orders.cancel');
  assert.equal(permit.orderMutationPerformed,false);
  assert.equal(permit.authorizationSource,'m4+m9_lab');
  assert.equal(Object.hasOwn(permit,'sessionToken'),false);
  assert.equal(Object.hasOwn(permit,'email'),false);
  assert.equal(checkedOwnership,1);
  const logs=await securityPool.query<{decision:string}>(
   'SELECT decision FROM tala_security_v2.audit_events '+
   "WHERE action='orders.cancel' ORDER BY id DESC LIMIT 1");
  assert.equal(logs.rows[0]?.decision,'allow');

  await assert.rejects(gate.authorizeLabOrderCancel({
   sessionToken:actor.login.sessionToken,orderId:otherOrder
  }),e=>errorCode(e,'M11_OWNERSHIP_NOT_VERIFIED'));
  assert.equal(checkedOwnership,2);
  await logoutLabSession(usersPool,{
   sessionToken:actor.login.sessionToken,secret:pepper
  });
  await assert.rejects(gate.authorizeLabOrderCancel({
   sessionToken:actor.login.sessionToken,orderId:ownedOrder
  }),e=>errorCode(e,'M11_IDENTITY_NOT_AUTHENTICATED'));
  assert.equal(checkedOwnership,2,
   'revoked M4 session must be rejected before any ownership lookup');
  await assert.rejects(gate.authorizeLabOrderCancel({
   sessionToken:'not-a-real-session',orderId:ownedOrder
  }),e=>errorCode(e,'M11_IDENTITY_NOT_AUTHENTICATED'));
 }finally{await Promise.all([usersPool.end(),securityPool.end()]);}
});

test('M11 M4/M9 refuses spoofed ownership attestation even for active session',
 {skip:!enabled,timeout:120000},async()=>{
 const usersPool=new pg.Pool({connectionString:usersUrl,max:10});
 const securityPool=new pg.Pool({connectionString:securityUrl,max:10});
 const pepper=randomBytes(32),mailSecret=randomBytes(32);
 const security:SecurityConfig={
  pool:securityPool,keyring:{gate01:randomBytes(32)},
  pseudonymKey:randomBytes(32)
 };
 try{
  const actor=await activeLabUser(usersPool,pepper,mailSecret);
  const orderId=id();
  const gate=createIdentitySecurityLabGate({
   usersPool,usersPasswordPepper:pepper,security,grantKeyId:'gate01',
   verifyOwnershipFromHost:async({subjectId})=>({
    subjectId,resourceId:id(),allowed:true,
    evidenceSource:'trusted_lab_host'
   })
  });
  await assert.rejects(gate.authorizeLabOrderCancel({
   sessionToken:actor.login.sessionToken,orderId
  }),e=>errorCode(e,'M11_OWNERSHIP_NOT_VERIFIED'));
  const fakeSource=createIdentitySecurityLabGate({
   usersPool,usersPasswordPepper:pepper,security,grantKeyId:'gate01',
   verifyOwnershipFromHost:async({subjectId})=>({
    subjectId,resourceId:orderId,allowed:true,
    evidenceSource:'frontend_claimed' as 'trusted_lab_host'
   })
  });
  await assert.rejects(fakeSource.authorizeLabOrderCancel({
   sessionToken:actor.login.sessionToken,orderId
  }),e=>errorCode(e,'M11_OWNERSHIP_NOT_VERIFIED'));
 }finally{await Promise.all([usersPool.end(),securityPool.end()]);}
});
