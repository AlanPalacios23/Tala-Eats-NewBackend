import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createCreceEnrollmentLab} from '../adapters/crece-enrollment-gateway-lab.js';
import {IntegrationError} from '../src/events.js';
import {createStore} from '../../restaurants/src/stores.js';
import {registerCredentialedPendingUser,loginLabUser,
 beginLabTotpEnrollment,confirmLabTotpEnrollment,
 logoutLabSession} from '../../users/src/auth.js';
import {issueLabEmailChallenge,verifyLabEmailChallenge}
 from '../../users/src/store.js';
import {totpCode} from '../../users/src/totp.js';
import type {SecurityConfig} from '../../security/src/gate.js';

const URLs={
 users:process.env.USERS_CI_URL??'',
 security:process.env.SECURITY_CI_URL??'',
 restaurants:process.env.RESTAURANTS_CI_URL??'',
 integration:process.env.INTEGRATION_CI_URL??''
};
const enabled=Object.entries(URLs).every(([key,url])=>
 url.includes('/tala_'+(key==='integration'?'integration':
  key==='restaurants'?'restaurants':key==='security'?'security':'users')+'_v2_test'));
const password='Tala-Crece-2026!Piloto-Largo';
const pepper=randomBytes(32),emailSecret=randomBytes(32),
 totpSecret=randomBytes(32);
const uid=()=>randomUUID();
const isErr=(code:string)=>(e:unknown)=>e instanceof IntegrationError&&e.code===code;
type Actor={id:string;session:string;email:string};

async function account(db:pg.Pool,role:'merchant'|'staff'|'customer'){
 const email='crece-'+uid()+'@example.com';
 const created=await registerCredentialedPendingUser(db,{
  email,displayName:'Comercio Prueba',password,
  secret:pepper,idempotencyKey:uid()
 });
 const userId=created.user.id;
 const proof=await issueLabEmailChallenge(db,{userId,secret:emailSecret});
 await verifyLabEmailChallenge(db,{
  userId,actorId:userId,token:proof.token,secret:emailSecret,
  expectedVersion:1,idempotencyKey:uid()
 });
 if(role==='staff'){
  const first=await loginLabUser(db,{email,password,secret:pepper});
  const begin=await beginLabTotpEnrollment(db,{
   sessionToken:first.sessionToken,secret:pepper,totpSecret,
   currentPassword:password
  });
  await confirmLabTotpEnrollment(db,{
   sessionToken:first.sessionToken,secret:pepper,totpSecret,
   code:totpCode(begin.secretBase32,Math.floor(Date.now()/30000))
  });
  await db.query(
   "UPDATE tala_users_v2.account_roles SET role='staff' WHERE account_id=$1::uuid",
   [userId]);
  const login=await loginLabUser(db,{email,password,secret:pepper,
   totpSecret,totpCode:totpCode(begin.secretBase32,Math.floor(Date.now()/30000)+1)});
  return {id:userId,session:login.sessionToken,email};
 }
 if(role==='merchant')await db.query(
  "UPDATE tala_users_v2.account_roles SET role='merchant' WHERE account_id=$1::uuid",
  [userId]);
 const login=await loginLabUser(db,{email,password,secret:pepper});
 return {id:userId,session:login.sessionToken,email};
}
async function newStore(db:pg.Pool,actor:Actor){
 const r=await createStore(db,{actorId:actor.id},{
  operationId:uid(),slug:'crece-gate-'+uid().slice(0,12),
  name:'Restaurante prueba',kind:'restaurant'
 });
 return r.id;
}
const agreement={
 termsAccepted:true as const,agreementVersion:'crece-founder-pilot-2026-11-v1'
};

test('Crece M4+M6+M9+M11: explicit consent, admin queue, quota=10 and isolation',
 {skip:!enabled,timeout:210000},async()=>{
 const usersPool=new pg.Pool({connectionString:URLs.users,max:12});
 const restaurantsPool=new pg.Pool({connectionString:URLs.restaurants,max:12});
 const securityPool=new pg.Pool({connectionString:URLs.security,max:12});
 const integrationPool=new pg.Pool({connectionString:URLs.integration,max:12});
 const config={usersPool,restaurantsPool,integrationPool,
  usersPasswordPepper:pepper,
  security:{pool:securityPool,keyring:{crece01:randomBytes(32)},
   pseudonymKey:randomBytes(32)} satisfies SecurityConfig,
  grantKeyId:'crece01'
 };
 const gate=createCreceEnrollmentLab(config);
 const storeIds:string[]=[],applications:string[]=[];
 try{
  const [one,two,three,admin,stranger]=await Promise.all([
   account(usersPool,'merchant'),account(usersPool,'merchant'),
   account(usersPool,'merchant'),account(usersPool,'staff'),
   account(usersPool,'customer')
  ]);
  assert.equal((await gate.listForAdmin({sessionToken:admin.session})).capacity,10);
  await assert.rejects(gate.listForAdmin({sessionToken:stranger.session}),
   isErr('M11_CRECE_SESSION_OR_ROLE_DENIED'));
  const firstStore=await newStore(restaurantsPool,one);
  await assert.rejects(gate.submit({
   sessionToken:stranger.session,storeId:firstStore,operationId:uid(),
   ...agreement,marketingOptIn:false
  }),isErr('M11_CRECE_SESSION_OR_ROLE_DENIED'));
  await assert.rejects(gate.submit({
   sessionToken:two.session,storeId:firstStore,operationId:uid(),
   ...agreement,marketingOptIn:false
  }),isErr('M11_CRECE_OWNER_REQUIRED'));
  await assert.rejects(gate.submit({
   sessionToken:one.session,storeId:firstStore,operationId:uid(),
   termsAccepted:false as unknown as true,
   agreementVersion:agreement.agreementVersion,marketingOptIn:false
  }),isErr('M11_CRECE_EXPLICIT_TERMS_REQUIRED'));

  // Twelve store-interest applications, no privacy leakage or auto approval.
  // Each merchant sends no more than four requests/min (M9 per-subject limit=6).
  for(let i=0;i<12;i++){
   const merchant=[one,two,three][Math.floor(i/4)]!;
   const storeId=i===0?firstStore:await newStore(restaurantsPool,merchant);
   const res=await gate.submit({
    sessionToken:merchant.session,storeId,operationId:uid(),
    ...agreement,marketingOptIn:i%2===1
   });
   assert.equal(res.consentRecorded,true);
   assert.equal(res.founderSeatGranted,false);
   storeIds.push(storeId);applications.push(res.applicationId);
  }
  assert.equal((await gate.readMyStatus({
   sessionToken:one.session,storeId:storeIds[0]!
  })).status,'interested');
  await assert.rejects(gate.readMyStatus({
   sessionToken:two.session,storeId:storeIds[0]!
  }),isErr('M11_CRECE_OWNER_REQUIRED'));
  const before=await gate.listForAdmin({sessionToken:admin.session});
  assert.equal(before.seatsApproved,0);
  assert.ok(before.applicants.length>=12);
  // Exact keyset pagination keeps all applicants, no duplicate from
  // PostgreSQL microsecond timestamps truncated to JS milliseconds.
  const firstPage=await gate.listForAdmin({sessionToken:admin.session,limit:5});
  assert.equal(firstPage.applicants.length,5);
  assert.ok(firstPage.nextCursor);
  const secondPage=await gate.listForAdmin({
   sessionToken:admin.session,limit:5,cursor:firstPage.nextCursor!
  });
  assert.equal(secondPage.applicants.length,5);
  assert.ok(secondPage.nextCursor);
  const thirdPage=await gate.listForAdmin({
   sessionToken:admin.session,limit:5,cursor:secondPage.nextCursor!
  });
  assert.equal(thirdPage.applicants.length,2);
  assert.equal(thirdPage.nextCursor,null);
  const paged=[...firstPage.applicants,...secondPage.applicants,...thirdPage.applicants];
  assert.equal(new Set(paged.map(x=>x.applicationId)).size,12);
  assert.equal(new Set(paged.map(x=>x.storeId)).size,12);
  assert.equal(paged.every(x=>x.status==='interested'),true);
  await assert.rejects(gate.listForAdmin({
   sessionToken:admin.session,limit:101
  }),isErr('M11_CRECE_PAGE_LIMIT_INVALID'));
  await assert.rejects(gate.listForAdmin({
   sessionToken:admin.session,cursor:{createdAt:'bad',applicationId:uid()}
  }),isErr('M11_CRECE_CURSOR_INVALID'));
  await assert.rejects(gate.listForAdmin({
   sessionToken:admin.session,
   cursor:{createdAt:new Date().toISOString(),applicationId:'invalid'}
  }),isErr('M11_CRECE_CURSOR_INVALID'));
  await assert.rejects(gate.listForAdmin({
   sessionToken:admin.session,status:'unknown' as 'approved'
  }),isErr('M11_CRECE_STATUS_FILTER_INVALID'));
  assert.ok(!JSON.stringify(before).includes(one.email));
  assert.ok(!JSON.stringify(before).includes(one.session));

  // Reject one with a coded, immutable reason; rejection never uses a seat.
  const declined=await gate.review({
   sessionToken:admin.session,applicationId:applications[0]!,
   operationId:uid(),decision:'declined',reasonCode:'not_eligible'
  });
  assert.equal(declined.decision,'declined');
  assert.equal(declined.founderSeatGranted,false);
  assert.equal((await gate.readMyStatus({
   sessionToken:one.session,storeId:storeIds[0]!
  })).status,'declined');

  // Eleven simultaneously arrive for only TEN available seats.
  // The PostgreSQL quota row is the arbiter, never the frontend count.
  const candidates=applications.slice(1).map((app,index)=>({
   applicationId:app,operationId:uid(),storeIndex:index+1
  }));
  const attempted=await Promise.allSettled(candidates.map(c=>
   gate.review({sessionToken:admin.session,
    applicationId:c.applicationId,operationId:c.operationId,
    decision:'approved'})));
  const winners=attempted.flatMap((result,index)=>
   result.status==='fulfilled'?[{...candidates[index]!,
    response:result.value}]:[]);
  const losers=attempted.filter(r=>r.status==='rejected');
  assert.equal(winners.length,10);
  assert.equal(losers.length,1);
  assert.ok(losers.every(r=>r.status==='rejected'&&
   isErr('M11_CRECE_CAPACITY_FULL')(r.reason)));
  assert.ok(winners.every(w=>w.response.founderSeatGranted&&
   !w.response.replayed));
  const quota=await gate.listForAdmin({sessionToken:admin.session});
  assert.equal(quota.capacity,10);
  assert.equal(quota.seatsApproved,10);
  assert.equal(quota.seatsRemaining,0);
  const approved=await gate.listForAdmin({
   sessionToken:admin.session,status:'approved',limit:10
  });
  assert.equal(approved.applicants.length,10);
  assert.ok(approved.applicants.every(x=>x.status==='approved'));
  const declinedList=await gate.listForAdmin({
   sessionToken:admin.session,status:'declined'
  });
  assert.equal(declinedList.applicants.length,1);
  const firstWin=winners[0]!;
  const ownerOfWin=[one,two,three][Math.floor(firstWin.storeIndex/4)]!;
  const verified=await gate.readMyStatus({
   sessionToken:ownerOfWin.session,storeId:storeIds[firstWin.storeIndex]!
  });
  assert.equal(verified.status,'approved');
  assert.equal(verified.founderSeatGranted,true);

  // Exact same review operation replays without consuming an eleventh seat.
  const replay=await gate.review({
   sessionToken:admin.session,applicationId:firstWin.applicationId,
   operationId:firstWin.operationId,decision:'approved'
  });
  assert.equal(replay.replayed,true);
  assert.equal(replay.founderSeatGranted,true);
  const count=await integrationPool.query<{approved_count:number}>(
   'SELECT approved_count FROM tala_integration_v2.crece_founder_quota');
  assert.equal(count.rows[0]!.approved_count,10);
  await assert.rejects(gate.review({
   sessionToken:stranger.session,applicationId:applications[11]!,
   operationId:uid(),decision:'approved'
  }),isErr('M11_CRECE_SESSION_OR_ROLE_DENIED'));

  const audit=await integrationPool.query<{n:number}>(
   "SELECT count(*)::int AS n FROM tala_integration_v2.crece_founder_review_events "+
   'WHERE application_id=ANY($1::uuid[])',[applications]);
  assert.equal(audit.rows[0]?.n,11); // 10 approved, 1 declined
  await assert.rejects(integrationPool.query(
   'DELETE FROM tala_integration_v2.crece_founder_reviews WHERE application_id=$1::uuid',
   [applications[1]]));
  // A previously valid merchant that loses its M4 merchant role must not
  // receive a founder seat on review, even with consent on disk.
  const staleStore=await newStore(restaurantsPool,one);
  const stale=await gate.submit({
   sessionToken:one.session,storeId:staleStore,operationId:uid(),
   ...agreement,marketingOptIn:false
  });
  await usersPool.query(
   "UPDATE tala_users_v2.account_roles SET role='customer' WHERE account_id=$1::uuid",
   [one.id]);
  await assert.rejects(gate.review({
   sessionToken:admin.session,applicationId:stale.applicationId,
   operationId:uid(),decision:'approved'
  }),isErr('M11_CRECE_APPLICANT_NO_LONGER_ELIGIBLE'));
  await logoutLabSession(usersPool,{sessionToken:admin.session,secret:pepper});
  await assert.rejects(gate.listForAdmin({sessionToken:admin.session}),
   isErr('M11_CRECE_SESSION_OR_ROLE_DENIED'));

  process.env.NODE_ENV='production';
  await assert.rejects(gate.review({
   sessionToken:admin.session,applicationId:applications[11]!,
   operationId:uid(),decision:'approved'
  }),isErr('M11_CRECE_COMMERCIAL_DISABLED'));
 }finally{
  if(process.env.NODE_ENV==='production')delete process.env.NODE_ENV;
  await Promise.all([usersPool.end(),restaurantsPool.end(),
   securityPool.end(),integrationPool.end()]);
 }
});
