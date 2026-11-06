/** Fail-closed admission for integrated LAB. No production modes or URLs.
 * One disposable PostgreSQL server MAY host isolated databases by domain.
 */
import {IntegrationError} from './events.js';
export const DATABASES={
 core:'tala_core_v2_test',finance:'tala_finance_v2_test',
 users:'tala_users_v2_test',notifications:'tala_notifications_v2_test',
 restaurants:'tala_restaurants_v2_test',locations:'tala_locations_v2_test',
 payments:'tala_payments_v2_test',security:'tala_security_v2_test',
 analytics:'tala_analytics_v2_test',integration:'tala_integration_v2_test'
} as const;
export type DbKey=keyof typeof DATABASES;
const RESTRICTED=[
 'CORE_V2_WRITES_ENABLED','CORE_V2_INTEGRATION_WRITES_ENABLED',
 'CORE_V2_INTEGRATION_LIVE_PAYMENTS_ENABLED',
 'CORE_V2_INTEGRATION_PAYOUTS_ENABLED',
 'CORE_V2_INTEGRATION_PUBLIC_HTTP_ENABLED'
];
export function checkIntegrationAdmission(
 env:Record<string,string|undefined>,urls:Record<DbKey,string>){
 if(env.NODE_ENV==='production'||env.CORE_V2_INTEGRATION_RUNTIME!=='isolated-lab'||
   RESTRICTED.some(k=>env[k]==='true'))
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 const seen=new Set<string>();
 for(const [key,name] of Object.entries(DATABASES)){
  const raw=urls[key as DbKey];
  if(typeof raw!=='string'||raw.length>500)
   throw new IntegrationError('M11_ISOLATED_DATABASE_REQUIRED');
  let u:URL;
  try{u=new URL(raw);}catch{throw new IntegrationError('M11_ISOLATED_DATABASE_REQUIRED');}
  if(!['postgres:','postgresql:'].includes(u.protocol)||
   !['localhost','127.0.0.1','::1','[::1]'].includes(u.hostname)||
   u.pathname!=='/'+name||u.search||u.hash||
   !u.username||!u.password||u.port&&(!/^\d+$/.test(u.port)))
   throw new IntegrationError('M11_ISOLATED_DATABASE_REQUIRED');
  if(seen.has(u.pathname))throw new IntegrationError('M11_ISOLATED_DATABASE_REQUIRED');
  seen.add(u.pathname);
 }
 return Object.freeze({admitted:true as const,commercialReady:false as const,
  livePayments:false as const,payouts:false as const,moduleCount:10,
  separateDatabases:true as const});
}
