/** One loopback-only PM2 process for real M1–M11 LAB9 composition.
 * No business routes, no live DB, no Stripe, no HTTP ingress from the WAN.
 */
import {DATABASES,type DbKey} from '../modules/integration/src/admission.js';
import {assembleIsolatedLab9} from '../modules/integration/src/assembly-lab9.js';

const PORT=18286;
function fail(message:string):never{throw Error('RC5_PM2_STAGE_'+message);}
if(process.env.NODE_ENV!=='test'||
   process.env.CORE_V2_INTEGRATION_RUNTIME!=='isolated-lab'||
   ['CORE_V2_WRITES_ENABLED','CORE_V2_INTEGRATION_WRITES_ENABLED',
    'CORE_V2_INTEGRATION_PUBLIC_HTTP_ENABLED',
    'CORE_V2_INTEGRATION_LIVE_PAYMENTS_ENABLED',
    'CORE_V2_INTEGRATION_PAYOUTS_ENABLED']
    .some(key=>process.env[key]!=='false'))
 fail('DENIED');
if(process.env.DATABASE_URL||process.env.STRIPE_SECRET_KEY||
   process.env.STRIPE_WEBHOOK_SECRET||process.env.PGHOST)
 fail('CREDENTIALS_PRESENT');
const dbUrls=Object.fromEntries(Object.entries(DATABASES).map(([key,name])=>
 [key,'postgresql://m11_inert_user:disabled@127.0.0.1:65534/'+name]
)) as Record<DbKey,string>;
const assembly=await assembleIsolatedLab9({
 env:process.env,dbUrls
});
const stop=async()=>{
 await assembly.close().catch(()=>{});
 process.exit(0);
};
process.once('SIGTERM',()=>{void stop();});
process.once('SIGINT',()=>{void stop();});
try{
 await new Promise<void>((done,reject)=>
  assembly.gateway.listen(PORT,'127.0.0.1',done).once('error',reject));
 process.stdout.write('RC5_PM2_STAGE_BOUND_LOOPBACK_ONLY='+PORT+'\n');
 process.stdout.write('RC5_COMMERCIAL_READY=false\n');
}catch(error){
 await assembly.close().catch(()=>{});
 throw error;
}
