/** M11 LAB3 real M4 session -> M9 security decision.
 * This is an INTERNAL orchestration adapter, not a public cancel endpoint.
 * A separate authoritative M1 resource-ownership adapter is REQUIRED:
 * accepting owner authorization from the browser is never permissible.
 * No DB writes to M1 and no public signing of M9 grants.
 */
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {readAuthenticatedProfile} from '../../users/src/auth.js';
import {authorizeSecurityAction,type SecurityConfig} from
 '../../security/src/gate.js';
import {signHostGrant,type HostGrant} from
 '../../security/src/grants.js';
import {IntegrationError,validUuid} from '../src/events.js';

export type OwnershipAssertion={
 subjectId:string,resourceId:string,allowed:true,
 evidenceSource:'trusted_lab_host'
};

type Config={
 usersPool:Pool,usersPasswordPepper:Buffer,
 security:SecurityConfig,grantKeyId:string,
 verifyOwnershipFromHost:(input:{
  subjectId:string,orderId:string
 })=>Promise<OwnershipAssertion|null>
};

export function createIdentitySecurityLabGate(config:Config){
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 if(!config||typeof config.verifyOwnershipFromHost!=='function')
  throw new IntegrationError('M11_TRUSTED_OWNER_ADAPTER_REQUIRED');
 return Object.freeze({
  /** Evaluate ONE cancellation. Only the M1 owner may later execute it. */
  authorizeLabOrderCancel:async(input:{
   sessionToken:string,orderId:string
  }):Promise<Readonly<{authorized:true,action:'orders.cancel',
   resourceId:string,authorizationSource:'m4+m9_lab',
   orderMutationPerformed:false}>>=>{
   if(process.env.NODE_ENV==='production')
    throw new IntegrationError('M11_COMMERCIAL_DISABLED');
   const orderId=validUuid(input.orderId);
   // M4 checks active identity, session expiry/revocation, and its MFA
   // rules. Never cache the profile or put its PII in M11 logs.
   let actor:{id:string};
   try{
    actor=await readAuthenticatedProfile(config.usersPool,{
     sessionToken:input.sessionToken,secret:config.usersPasswordPepper
    });
   }catch{
    throw new IntegrationError('M11_IDENTITY_NOT_AUTHENTICATED');
   }
   const subjectId=validUuid(actor.id);
   const ownership=await config.verifyOwnershipFromHost({subjectId,orderId});
   if(!ownership||ownership.allowed!==true||
      ownership.evidenceSource!=='trusted_lab_host'||
      ownership.subjectId!==subjectId||
      ownership.resourceId!==orderId)
    throw new IntegrationError('M11_OWNERSHIP_NOT_VERIFIED');
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
   if(!decision.allowed)
    throw new IntegrationError('M11_SECURITY_DENIED');
   return Object.freeze({authorized:true as const,
    action:'orders.cancel' as const,resourceId:orderId,
    authorizationSource:'m4+m9_lab' as const,
    orderMutationPerformed:false as const});
  }
 });
}
