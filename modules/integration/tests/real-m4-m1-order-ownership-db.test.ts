import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {IntegrationError} from '../src/events.js';
import {createM11AuthenticatedLabGateway,listenM11AuthenticatedLabGateway}
 from '../src/authenticated-gateway-lab.js';
import {createIdentitySecurityLabGate} from '../adapters/identity-security-lab.js';
import {linkControlledCustomerAccounts,createVerifiedM1OwnershipResolver,
 revokeLinkedCustomerAccount,type IdentityLinkConfig}
 from '../adapters/order-ownership-lab.js';
import {registerCredentialedPendingUser,loginLabUser,logoutLabSession}
 from '../../users/src/auth.js';
import {issueLabEmailChallenge,verifyLabEmailChallenge}
 from '../../users/src/store.js';
import {hashPassword,issueSession,resolveSession,tokenHash}
 from '../../../src/modules/orders/lab-auth.ts';
import {createCashOrder}
 from '../../../src/modules/orders/checkout.ts';
import type {SecurityConfig} from '../../security/src/gate.js';

const integrationUrl=process.env.INTEGRATION_CI_URL??'';
const usersUrl=process.env.USERS_CI_URL??'';
const coreUrl=process.env.CORE_CI_URL??'';
const securityUrl=process.env.SECURITY_CI_URL??'';
const enabled=integrationUrl.includes('/tala_integration_v2_test')&&
 usersUrl.includes('/tala_users_v2_test')&&
 coreUrl.includes('/tala_core_v2_test')&&
 securityUrl.includes('/tala_security_v2_test');
const uid=()=>randomUUID();
const password='Tala-M11-Owners#2026-Strong';
const errorCode=(error:unknown,code:string)=>
 error instanceof IntegrationError&&error.code===code;

async function makeM4Account(pool:pg.Pool,email:string,
 passwordPepper:Buffer,emailSecret:Buffer){
 const created=await registerCredentialedPendingUser(pool,{
  email,displayName:'Cliente M11 LAB4',password,
  secret:passwordPepper,idempotencyKey:uid()
 });
 const issued=await issueLabEmailChallenge(pool,{
  userId:created.user.id,secret:emailSecret
 });
 await verifyLabEmailChallenge(pool,{
  userId:created.user.id,actorId:created.user.id,
  token:issued.token,secret:emailSecret,expectedVersion:1,
  idempotencyKey:uid()
 });
 const logged=await loginLabUser(pool,{email,password,secret:passwordPepper});
 return {id:created.user.id,session:logged.sessionToken};
}
async function makeM1Customer(pool:pg.Pool,email:string){
 const hashed=await hashPassword(password);
 const rows=await pool.query<{id:string}>(
  'INSERT INTO tala_core_v2.accounts(email,display_name,password_hash,role) '+
  "VALUES($1,'Cliente Legacy M1',$2,'customer') RETURNING id",[email,hashed]);
 const id=rows.rows[0]!.id;
 const session=await issueSession(pool,id);
 assert.equal((await resolveSession(pool,session))?.id,id);
 return {id,session};
}
async function makeM1Order(pool:pg.Pool,buyerId:string){
 const restaurant=await pool.query<{id:string}>(
  'INSERT INTO tala_core_v2.restaurants(name,is_open) '+
  "VALUES('LAB4 Tienda',true) RETURNING id");
 const restaurantId=restaurant.rows[0]!.id;
 const product=await pool.query<{id:string}>(
  'INSERT INTO tala_core_v2.catalog_products '+
  '(restaurant_id,name,price_minor,stock,is_available) '+
  "VALUES($1::uuid,'Producto LAB4',7500,20,true) RETURNING id",
  [restaurantId]);
 const order=await createCashOrder(pool,buyerId,{
  restaurantId,fulfillment:'pickup',paymentMethod:'cash',
  lines:[{productId:product.rows[0]!.id,quantity:1}],
  idempotencyKey:'m11-ownership-'+uid()
 });
 assert.equal(order.order.buyerId,buyerId);
 assert.equal(order.order.paymentStatus,'pending');
 return order.order.id;
}
function pools(){
 const integrationPool=new pg.Pool({connectionString:integrationUrl,max:12});
 const usersPool=new pg.Pool({connectionString:usersUrl,max:12});
 const ordersPool=new pg.Pool({connectionString:coreUrl,max:12});
 const securityPool=new pg.Pool({connectionString:securityUrl,max:12});
 const pepper=randomBytes(32),emailSecret=randomBytes(32);
 const config:IdentityLinkConfig={
  integrationPool,usersPool,ordersPool,usersPasswordPepper:pepper
 };
 const security:SecurityConfig={pool:securityPool,
  keyring:{gate01:randomBytes(32)},pseudonymKey:randomBytes(32)};
 return {config,security,pepper,emailSecret,
  close:()=>Promise.all([integrationPool.end(),usersPool.end(),
   ordersPool.end(),securityPool.end()])};
}

test('M11 LAB4: dual active M4/M1 sessions link customers; REAL M1 order scope + M9 grant',
 {skip:!enabled,timeout:120000},async()=>{
 const lab=pools();
 try{
  const emailA='owner.'+uid()+'@example.com';
  const emailB='owner.'+uid()+'@example.com';
  const m4a=await makeM4Account(lab.config.usersPool,emailA,
   lab.pepper,lab.emailSecret);
  const m4b=await makeM4Account(lab.config.usersPool,emailB,
   lab.pepper,lab.emailSecret);
  const m1a=await makeM1Customer(lab.config.ordersPool,emailA);
  const m1b=await makeM1Customer(lab.config.ordersPool,emailB);
  const orderA=await makeM1Order(lab.config.ordersPool,m1a.id);
  const orderB=await makeM1Order(lab.config.ordersPool,m1b.id);
  const linked=await linkControlledCustomerAccounts(lab.config,{
   m4SessionToken:m4a.session,m1SessionToken:m1a.session
  });
  assert.equal(linked.linked,true);
  assert.equal(linked.replayed,false);
  assert.equal(linked.m4UserId,m4a.id);
  assert.equal(linked.m1CustomerId,m1a.id);
  assert.equal((await linkControlledCustomerAccounts(lab.config,{
   m4SessionToken:m4a.session,m1SessionToken:m1a.session
  })).replayed,true);
  await linkControlledCustomerAccounts(lab.config,{
   m4SessionToken:m4b.session,m1SessionToken:m1b.session
  });

  const gate=createIdentitySecurityLabGate({
   usersPool:lab.config.usersPool,usersPasswordPepper:lab.pepper,
   security:lab.security,grantKeyId:'gate01',
   verifyOwnershipFromHost:createVerifiedM1OwnershipResolver(lab.config)
  });
  const authorized=await gate.authorizeLabOrderCancel({
   sessionToken:m4a.session,orderId:orderA
  });
  assert.equal(authorized.authorized,true);
  assert.equal(authorized.orderMutationPerformed,false);
  assert.equal(authorized.resourceId,orderA);
  // RC2 real HTTP: the exact same M4 session, linked M1 order ownership
  // and M9 scoped grant must pass. HTTP never executes cancellation.
  const http=createM11AuthenticatedLabGateway({
   env:{NODE_ENV:'test',CORE_V2_INTEGRATION_RUNTIME:'isolated-lab',
    CORE_V2_INTEGRATION_WRITES_ENABLED:'false'},cancel:gate
  });
  const httpPort=await listenM11AuthenticatedLabGateway(http);
  try{
   const base='http://127.0.0.1:'+httpPort+'/v2/lab/orders/';
   const headers={authorization:'Bearer '+m4a.session};
   const mine=await fetch(base+orderA+'/can-cancel',{headers});
   assert.equal(mine.status,200);
   const proof=await mine.json() as Record<string,unknown>;
   assert.equal(proof.authorized,true);
   assert.equal(proof.orderMutationPerformed,false);
   assert.equal(proof.resourceId,orderA);
   assert.equal(mine.headers.get('access-control-allow-origin'),null);
   assert.equal((await fetch(base+orderB+'/can-cancel',{headers})).status,403);
   assert.equal((await fetch(base+orderA+'/can-cancel')).status,401);
   assert.equal((await fetch('http://127.0.0.1:'+httpPort+'/v2/ready')).status,503);
   assert.equal((await fetch('http://127.0.0.1:'+httpPort+'/v2/orders',{
    method:'POST',headers:{'content-type':'application/json'},body:'{}'
   })).status,503);
  }finally{await new Promise<void>((resolve,reject)=>
   http.close(error=>error?reject(error):resolve()));}
  await assert.rejects(gate.authorizeLabOrderCancel({
   sessionToken:m4a.session,orderId:orderB
  }),e=>errorCode(e,'M11_OWNERSHIP_NOT_VERIFIED'));
  await assert.rejects(gate.authorizeLabOrderCancel({
   sessionToken:m4b.session,orderId:orderA
  }),e=>errorCode(e,'M11_OWNERSHIP_NOT_VERIFIED'));
  await assert.rejects(gate.authorizeLabOrderCancel({
   sessionToken:m4a.session,orderId:uid()
  }),e=>errorCode(e,'M11_OWNERSHIP_NOT_VERIFIED'));
  const count=await lab.security.pool.query<{n:number}>(
   "SELECT count(*)::int AS n FROM tala_security_v2.audit_events "+
   "WHERE action='orders.cancel' AND decision='allow'");
  assert.ok(count.rows[0]!.n>=1);

  const rows=await lab.config.integrationPool.query<
   {m4_user_id:string,m1_customer_id:string,proof_method:string}>(
   'SELECT m4_user_id,m1_customer_id,proof_method '+
   'FROM tala_integration_v2.customer_identity_links '+
   'WHERE m4_user_id=$1::uuid',[m4a.id]);
  assert.equal(rows.rows[0]?.m1_customer_id,m1a.id);
  assert.equal(rows.rows[0]?.proof_method,'dual_active_sessions_lab');
  assert.ok(!JSON.stringify(rows.rows).includes(emailA));
  assert.ok(!JSON.stringify(rows.rows).includes(m4a.session));
  assert.ok(!JSON.stringify(rows.rows).includes(m1a.session));

  await logoutLabSession(lab.config.usersPool,{
   sessionToken:m4a.session,secret:lab.pepper
  });
  await assert.rejects(gate.authorizeLabOrderCancel({
   sessionToken:m4a.session,orderId:orderA
  }),e=>errorCode(e,'M11_IDENTITY_NOT_AUTHENTICATED'));
 }finally{await lab.close();}
});

test('M11 LAB4: email equality is insufficient; BOTH valid customer sessions required',
 {skip:!enabled,timeout:120000},async()=>{
 const lab=pools();
 try{
  const a='unmatched.'+uid()+'@example.com';
  const b='unmatched.'+uid()+'@example.com';
  const m4=await makeM4Account(lab.config.usersPool,a,
   lab.pepper,lab.emailSecret);
  const m1=await makeM1Customer(lab.config.ordersPool,b);
  await assert.rejects(linkControlledCustomerAccounts(lab.config,{
   m4SessionToken:m4.session,m1SessionToken:m1.session
  }),e=>errorCode(e,'M11_IDENTITY_EMAIL_MISMATCH'));
  const m1same=await makeM1Customer(lab.config.ordersPool,a);
  await assert.rejects(linkControlledCustomerAccounts(lab.config,{
   m4SessionToken:m4.session,m1SessionToken:'f'.repeat(64)
  }),e=>errorCode(e,'M11_DUAL_SESSION_REQUIRED'));
  await assert.rejects(linkControlledCustomerAccounts(lab.config,{
   m4SessionToken:'invalid',m1SessionToken:m1same.session
  }),e=>errorCode(e,'M11_DUAL_SESSION_REQUIRED'));
  // A previously valid M1 session must not be usable after expiry.
  await lab.config.ordersPool.query(
   "UPDATE tala_core_v2.sessions SET expires_at=clock_timestamp()-interval '1 second' "+
   "WHERE token_hash=$1",[tokenHash(m1same.session)]);
  await assert.rejects(linkControlledCustomerAccounts(lab.config,{
   m4SessionToken:m4.session,m1SessionToken:m1same.session
  }),e=>errorCode(e,'M11_DUAL_SESSION_REQUIRED'));
  const freshM1Session=await issueSession(lab.config.ordersPool,m1same.id);
  const ok=await linkControlledCustomerAccounts(lab.config,{
   m4SessionToken:m4.session,m1SessionToken:freshM1Session
  });
  assert.equal(ok.linked,true);

  // Independent second active M4 account cannot seize the existing M1 link.
  // Different emails are also rejected before hitting the unique constraint.
  const second=await makeM4Account(lab.config.usersPool,b,
   lab.pepper,lab.emailSecret);
  await assert.rejects(linkControlledCustomerAccounts(lab.config,{
   m4SessionToken:second.session,m1SessionToken:freshM1Session
  }),e=>errorCode(e,'M11_IDENTITY_EMAIL_MISMATCH'));
  const stored=await lab.config.integrationPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_integration_v2.customer_identity_links '+
   'WHERE m1_customer_id=$1::uuid',[m1same.id]);
  assert.equal(stored.rows[0]?.n,1);
 }finally{await lab.close();}
});

test('M11 LAB4: M1 disabled or revoked link denies even with active M4 session',
 {skip:!enabled,timeout:120000},async()=>{
 const lab=pools();
 try{
  const email='revocation.'+uid()+'@example.com';
  const m4=await makeM4Account(lab.config.usersPool,email,
   lab.pepper,lab.emailSecret);
  const m1=await makeM1Customer(lab.config.ordersPool,email);
  const owned=await makeM1Order(lab.config.ordersPool,m1.id);
  await linkControlledCustomerAccounts(lab.config,{
   m4SessionToken:m4.session,m1SessionToken:m1.session
  });
  const owner=createVerifiedM1OwnershipResolver(lab.config);
  assert.equal((await owner({subjectId:m4.id,orderId:owned}))?.allowed,true);
  await lab.config.ordersPool.query(
   'UPDATE tala_core_v2.accounts SET is_active=false WHERE id=$1::uuid',
   [m1.id]);
  assert.equal(await owner({subjectId:m4.id,orderId:owned}),null);
  await lab.config.ordersPool.query(
   'UPDATE tala_core_v2.accounts SET is_active=true WHERE id=$1::uuid',
   [m1.id]);
  await assert.rejects(revokeLinkedCustomerAccount(lab.config,{
   authenticated:false,canRevokeIdentityLinks:true
  },m4.id,'owner_request'),e=>errorCode(e,'M11_FORBIDDEN'));
  const revoked=await revokeLinkedCustomerAccount(lab.config,{
   authenticated:true,canRevokeIdentityLinks:true
  },m4.id,'owner_request');
  assert.equal(revoked.revoked,true);
  assert.equal(revoked.replayed,false);
  assert.equal((await revokeLinkedCustomerAccount(lab.config,{
   authenticated:true,canRevokeIdentityLinks:true
  },m4.id,'owner_request')).replayed,true);
  assert.equal(await owner({subjectId:m4.id,orderId:owned}),null);
  await assert.rejects(linkControlledCustomerAccounts(lab.config,{
   m4SessionToken:m4.session,m1SessionToken:m1.session
  }),e=>errorCode(e,'M11_IDENTITY_LINK_REVOKED'));
  await assert.rejects(lab.config.integrationPool.query(
   'UPDATE tala_integration_v2.customer_identity_links '+
   'SET m1_customer_id=$1::uuid WHERE m4_user_id=$2::uuid',
   [uid(),m4.id]),/M11_EVENT_IMMUTABLE/);
  await assert.rejects(lab.config.integrationPool.query(
   'DELETE FROM tala_integration_v2.customer_link_revocations '+
   'WHERE m4_user_id=$1::uuid',[m4.id]),/M11_EVENT_IMMUTABLE/);
 }finally{await lab.close();}
});
