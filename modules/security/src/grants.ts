/** M9 verifies short-lived assertions from an independently trusted gateway.
 * M4 owns identity, MFA, session issuance and business role assignments.
 * M9 does not create user sessions, authenticate passwords or grant entitlements.
 * Lab signing helper is for trusted host/tests only: NEVER expose as HTTP.
 */
import {createHmac,timingSafeEqual} from 'node:crypto';

export class SecurityError extends Error{
 constructor(readonly code:string){super(code);this.name='SecurityError';}
}
export const ACTIONS={
 'orders.cancel':{limit:20,stepUp:false},
 'driver.delivery.complete':{limit:60,stepUp:false},
 'merchant.store.suspend':{limit:3,stepUp:true},
 'payments.refund.request':{limit:5,stepUp:true},
 'finance.payout.request':{limit:3,stepUp:true},
 'profile.export':{limit:3,stepUp:true},
 'crece.interest.submit':{limit:6,stepUp:false},
 'crece.founder.review':{limit:15,stepUp:false},
 'crece.founder.list':{limit:40,stepUp:false}
} as const;
export type SecurityAction=keyof typeof ACTIONS;
export type Assurance='session'|'step_up';
export type HostGrant={
 version:1,issuer:'tala-trusted-gateway-lab',audience:'m9-security-lab',
 grantId:string,subjectId:string,resourceId:string,action:SecurityAction,
 assurance:Assurance,assuranceAt:number|null,
 issuedAt:number,expiresAt:number
};
export type KeyRing=Readonly<Record<string,Buffer>>;
const KID=/^[a-z][a-z0-9_-]{2,31}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const FIELDS=['version','issuer','audience','grantId','subjectId','resourceId',
 'action','assurance','assuranceAt','issuedAt','expiresAt'];
export function validUuid(raw:unknown):string{
 if(typeof raw!=='string'||!UUID.test(raw))
  throw new SecurityError('M9_UUID_INVALID');
 return raw.toLowerCase();
}
function validGrant(raw:unknown,nowSeconds:number):HostGrant{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))
  throw new SecurityError('M9_GRANT_INVALID');
 const r=raw as Record<string,unknown>;
 if(Object.keys(r).length!==FIELDS.length||
    FIELDS.some(x=>!Object.hasOwn(r,x))||
    Object.keys(r).some(k=>!FIELDS.includes(k)))
  throw new SecurityError('M9_GRANT_INVALID');
 if(r.version!==1||r.issuer!=='tala-trusted-gateway-lab'||
    r.audience!=='m9-security-lab'||
    typeof r.action!=='string'||!Object.hasOwn(ACTIONS,r.action)||
    !['session','step_up'].includes(String(r.assurance)))
  throw new SecurityError('M9_GRANT_INVALID');
 try{
  validUuid(r.grantId);validUuid(r.subjectId);validUuid(r.resourceId);
 }catch{throw new SecurityError('M9_GRANT_INVALID');}
 if(!Number.isSafeInteger(r.issuedAt)||!Number.isSafeInteger(r.expiresAt)||
    (r.assuranceAt!==null&&!Number.isSafeInteger(r.assuranceAt)))
  throw new SecurityError('M9_GRANT_INVALID');
 const issued=r.issuedAt as number,expiry=r.expiresAt as number;
 if(expiry<=issued||expiry-issued>120)
  throw new SecurityError('M9_GRANT_INVALID');
 if(issued>nowSeconds+30||expiry<=nowSeconds)
  throw new SecurityError('M9_GRANT_EXPIRED');
 if(r.assurance==='session'&&r.assuranceAt!==null)
  throw new SecurityError('M9_GRANT_INVALID');
 return r as HostGrant;
}
function verifiedKey(keyring:KeyRing,kid:string){
 if(!KID.test(kid)||!Object.hasOwn(keyring,kid))throw new SecurityError('M9_GRANT_INVALID');
 const key=keyring[kid];
 if(!Buffer.isBuffer(key)||key.length<32)
  throw new SecurityError('M9_KEY_INVALID');
 return key;
}
export function signHostGrant(grant:HostGrant,kid:string,keyring:KeyRing){
 const key=verifiedKey(keyring,kid);
 // Trusted host only. No HTTP endpoint exists to mint security grants.
 validGrant(grant,Math.floor(Date.now()/1000));
 const payload=Buffer.from(JSON.stringify(grant)).toString('base64url');
 const signed='v1.'+kid+'.'+payload;
 const signature=createHmac('sha256',key).update(signed).digest('base64url');
 return signed+'.'+signature;
}
export function verifyHostGrant(token:string,keyring:KeyRing,now=Date.now()):HostGrant{
 if(typeof token!=='string'||token.length>4096||token.length<64||
    !Number.isSafeInteger(now))
  throw new SecurityError('M9_GRANT_INVALID');
 const parts=token.split('.');
 if(parts.length!==4||parts[0]!=='v1'||!KID.test(parts[1]??'')||
   !/^[A-Za-z0-9_-]+$/.test(parts[2]??'')||
   !/^[A-Za-z0-9_-]{43}$/.test(parts[3]??''))
  throw new SecurityError('M9_GRANT_INVALID');
 const key=verifiedKey(keyring,parts[1]!);
 const signed=parts.slice(0,3).join('.');
 const expected=createHmac('sha256',key).update(signed).digest();
 const actual=Buffer.from(parts[3]!,'base64url');
 if(actual.toString('base64url')!==parts[3])
  throw new SecurityError('M9_GRANT_INVALID');
 if(actual.length!==expected.length||!timingSafeEqual(expected,actual))
  throw new SecurityError('M9_GRANT_INVALID');
 const bytes=Buffer.from(parts[2]!,'base64url');
 if(bytes.length>2500||bytes.toString('base64url')!==parts[2])
  throw new SecurityError('M9_GRANT_INVALID');
 let raw:unknown;
 try{raw=JSON.parse(bytes.toString('utf8'));}catch{
  throw new SecurityError('M9_GRANT_INVALID');
 }
 return validGrant(raw,Math.floor(now/1000));
}
