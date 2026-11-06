/** RC3 LAB: genuine M4 session + M9 grant + M1 CASH cancellation.
 * No public route. No Stripe refund or wallet debit. It cannot run against
 * production databases and cannot replace the unified commercial gateway.
 */
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {readAuthenticatedProfile,readMyIdentityRole}
 from '../../users/src/auth.js';
import {authorizeSecurityAction,type SecurityConfig}
 from '../../security/src/gate.js';
import {signHostGrant,type HostGrant}
 from '../../security/src/grants.js';
import {cancelCashOrder} from '../../../src/modules/orders/cancel.ts';
import {createVerifiedM1OwnershipResolver,type IdentityLinkConfig}
 from './order-ownership-lab.js';
import {IntegrationError,validUuid} from '../src/events.js';

export type CustomerCancellationLabConfig=IdentityLinkConfig&{
 security:SecurityConfig,grantKeyId:string
};
function labOnly(){
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
}
async function assertDatabase(pool:Pool,name:string){
 labOnly();
 const db=await pool.query<{name:string}>('SELECT current_database() AS name');
 if(db.rows[0]?.name!==name)throw new IntegrationError('M11_LAB_ONLY');
}
const COMMAND=/^[A-Za-z0-9_.:-]{16,128}$/;

/** Only a currently authenticated M4 customer may cancel an M1 CASH order
 * that is verified as theirs by the persistent M4↔M1 link AND M1's owner
 * query. M9 audits a one-time grant before M1 performs its transactional,
 * idempotent cancel and stock restoration. No claimed buyer ID is accepted.
 */
export async function cancelLinkedM4CashOrderLab(
 config:CustomerCancellationLabConfig,input:{
  m4SessionToken:string,orderId:string,
  expectedVersion:bigint,commandKey:string
 }){
 labOnly();
 const orderId=validUuid(input?.orderId);
 if(typeof input.m4SessionToken!=='string'||
    typeof input.expectedVersion!=='bigint'||input.expectedVersion<1n||
    typeof input.commandKey!=='string'||!COMMAND.test(input.commandKey))
  throw new IntegrationError('M11_CANCEL_INPUT_INVALID');
 if(!config?.security||typeof config.grantKeyId!=='string')
  throw new IntegrationError('M11_GATE_CONFIG_INVALID');
 await Promise.all([
  assertDatabase(config.integrationPool,'tala_integration_v2_test'),
  assertDatabase(config.ordersPool,'tala_core_v2_test'),
  assertDatabase(config.security.pool,'tala_security_v2_test')
 ]);
 const session={sessionToken:input.m4SessionToken,
  secret:config.usersPasswordPepper};
 const actor=await readAuthenticatedProfile(config.usersPool,session)
  .catch(()=>null);
 if(!actor)throw new IntegrationError('M11_IDENTITY_NOT_AUTHENTICATED');
 const subjectId=validUuid(actor.id);
 const role=await readMyIdentityRole(config.usersPool,session)
  .catch(()=>null);
 if(role?.userId!==subjectId||role.role!=='customer')
  throw new IntegrationError('M11_CUSTOMER_ROLE_REQUIRED');
 const resolver=createVerifiedM1OwnershipResolver(config);
 const ownership=await resolver({subjectId,orderId});
 if(!ownership?.allowed||ownership.resourceId!==orderId||
    ownership.subjectId!==subjectId)
  throw new IntegrationError('M11_OWNERSHIP_NOT_VERIFIED');
 // M11 does not accept actorId from the browser: it reads a current,
 // non-revoked, immutable link, then M1 checks its OWN buyer_id in SQL.
 const linked=await config.integrationPool.query<{m1_customer_id:string}>(
  'SELECT l.m1_customer_id FROM tala_integration_v2.customer_identity_links l '+
  'WHERE l.m4_user_id=$1::uuid AND NOT EXISTS('+
  'SELECT 1 FROM tala_integration_v2.customer_link_revocations r '+
  'WHERE r.m4_user_id=l.m4_user_id)',[subjectId]);
 const buyerId=linked.rows[0]?.m1_customer_id;
 if(!buyerId)throw new IntegrationError('M11_OWNERSHIP_NOT_VERIFIED');
 const now=Math.floor(Date.now()/1000);
 const grant:HostGrant={
  version:1,issuer:'tala-trusted-gateway-lab',audience:'m9-security-lab',
  grantId:randomUUID(),subjectId,resourceId:orderId,action:'orders.cancel',
  assurance:'session',assuranceAt:null,issuedAt:now-1,expiresAt:now+45
 };
 const signed=signHostGrant(grant,config.grantKeyId,config.security.keyring);
 const decision=await authorizeSecurityAction(config.security,{
  grant:signed,action:'orders.cancel',resourceId:orderId
 });
 if(!decision.allowed)throw new IntegrationError('M11_SECURITY_DENIED');
 // Keep ownership fresh after the security transaction. M1 itself checks
 // buyer id and version under FOR UPDATE; no cross-database atomicity claimed.
 if(!(await resolver({subjectId,orderId}))?.allowed)
  throw new IntegrationError('M11_OWNERSHIP_NOT_VERIFIED');
 const result=await cancelCashOrder(config.ordersPool,{
  orderId,actorId:validUuid(buyerId),actor:'customer',
  expectedVersion:input.expectedVersion,commandKey:input.commandKey
 });
 return Object.freeze({orderId:result.orderId,status:result.status,
  version:result.version.toString(),replayed:result.replayed,
  authorizedBy:'M4_M9_M1_LAB' as const,commercialReady:false as const,
  paymentRefundPerformed:false as const});
}
