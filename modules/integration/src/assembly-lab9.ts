/**
 * LAB9: assemble actual ten owned module entrypoints within ONE Node 24 process.
 *
 * This is an isolated, read-only composition gate, NOT the production gateway.
 * No credentials, users, checkouts, order mutations or business endpoints are
 * exposed; no real database or external provider is contacted. PostgreSQL
 * credentials below are deliberately inert and must never be substituted with
 * a working database until authentication and commerce gates are completed.
 *
 * M1/M2 share the same checkout, and M3/M2 stay internal workers. Every
 * remaining HTTP factory is loaded from the exact pinned source tree.
 */
import {createServer,Server,type IncomingMessage,type ServerResponse}
 from 'node:http';
import {randomBytes} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import pg from 'pg';
import {checkIntegrationAdmission,type DbKey} from './admission.js';
import {IntegrationError} from './events.js';

export const DOMAINS=['orders','logistics','finance','users','notifications',
 'restaurants','locations','payments','security','analytics'] as const;
export type Domain=typeof DOMAINS[number];
type Entry={path:string,exportName:string,kind:'http'|'internal'};
const SOURCE_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const ENTRIES:Readonly<Record<Domain,Entry>>={
 orders:{path:'src/modules/orders/lab-http.ts',exportName:'createOrderApp',kind:'http'},
 logistics:{path:'src/modules/logistics/tala-dispatch-engine.ts',
  exportName:'expireDispatchOffers',kind:'internal'},
 finance:{path:'modules/finance/src/store.mjs',
  exportName:'recordLabHeldAllocation',kind:'internal'},
 users:{path:'modules/users/src/http-lab.ts',
  exportName:'createUsersLabHttpServer',kind:'http'},
 notifications:{path:'modules/notifications/src/http-lab.ts',
  exportName:'createNotificationsLabHttpServer',kind:'http'},
 restaurants:{path:'modules/restaurants/src/http-lab.ts',
  exportName:'createRestaurantsLabHttpServer',kind:'http'},
 locations:{path:'modules/locations/src/http-lab.ts',
  exportName:'createLocationsLabHttpServer',kind:'http'},
 payments:{path:'modules/payments/src/http-lab.ts',
  exportName:'createPaymentsLabHttpServer',kind:'http'},
 security:{path:'modules/security/src/http-lab.ts',
  exportName:'createSecurityLabHttpServer',kind:'http'},
 analytics:{path:'modules/analytics/src/http-lab.ts',
  exportName:'createAnalyticsLabHttpServer',kind:'http'}
};
const HEALTH:Partial<Record<Domain,string>>={
 orders:'/api/v2/health',
 users:'/v1/users/health',notifications:'/v1/notifications/health',
 restaurants:'/v1/restaurants/health',locations:'/v1/locations/health',
 payments:'/v1/payments/health',security:'/v1/security/health',
 analytics:'/v1/analytics/health'
};
const LOCAL=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
type Handler=(req:IncomingMessage,res:ServerResponse)=>void;
type Active={kind:'http'|'internal',handler?:Handler};
export type LabAssembly={
 gateway:Server,modules:ReadonlyMap<Domain,Active>,close:()=>Promise<void>
};

function respond(res:ServerResponse,status:number,data:unknown){
 if(res.headersSent)return;
 const bytes=Buffer.from(JSON.stringify(data));
 res.writeHead(status,{
  'Content-Type':'application/json; charset=utf-8',
  'Content-Length':String(bytes.length),'Cache-Control':'private, no-store',
  'Content-Security-Policy':"default-src 'none'",
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'
 });
 res.end(bytes);
}
function ensureLab(env:Record<string,string|undefined>,
 dbUrls:Record<DbKey,string>){
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 return checkIntegrationAdmission(env,dbUrls);
}
async function loadOwnedFactory(domain:Domain):Promise<(arg:unknown)=>unknown>{
 const spec=ENTRIES[domain];
 const absolute=resolve(SOURCE_ROOT,spec.path);
 let exports:Record<string,unknown>;
 try{exports=await import(pathToFileURL(absolute).href) as Record<string,unknown>;}
 catch{throw new IntegrationError('M11_SOURCE_IMPORT_FAILED_'+domain.toUpperCase());}
 const fn=exports[spec.exportName];
 if(typeof fn!=='function')
  throw new IntegrationError('M11_SOURCE_EXPORT_MISSING_'+domain.toUpperCase());
 return fn as (arg:unknown)=>unknown;
}
function handlerOf(server:unknown,domain:Domain):Handler{
 if(!(server instanceof Server)||server.listening||server.listeners('request').length!==1)
  throw new IntegrationError('M11_FACTORY_INVALID_'+domain.toUpperCase());
 return (req,res)=>{server.emit('request',req,res);};
}
function healthGateway(modules:ReadonlyMap<Domain,Active>):Server{
 return createServer((req,res)=>{
  if(!LOCAL.has(req.socket.remoteAddress??'')||
     !LOCAL.has(req.socket.localAddress??'')){
   respond(res,403,{error:'M11_LOOPBACK_ONLY'});return;
  }
  if(typeof req.url!=='string'||req.url.length>2048||
     !req.url.startsWith('/')||req.url.startsWith('//')){
   respond(res,400,{error:'M11_PATH_INVALID'});return;
  }
  let u:URL;
  try{u=new URL(req.url,'http://127.0.0.1');}
  catch{respond(res,400,{error:'M11_PATH_INVALID'});return;}
  if(req.method==='GET'&&!u.search&&u.pathname==='/v2/health'){
   respond(res,200,{module:'M11',version:'LAB9',domainsLoaded:modules.size,
    oneProcess:true,commercialReady:false,businessEnabled:false});return;
  }
  if(req.method==='GET'&&!u.search&&u.pathname==='/v2/ready'){
   respond(res,503,{ready:false,commercialReady:false,
    reason:'M11_PRODUCTION_GATES_INCOMPLETE'});return;
  }
  if(req.method==='GET'&&!u.search&&u.pathname==='/v2/modules'){
   respond(res,200,{commercialReady:false,modules:DOMAINS.map(domain=>({
    domain,loaded:modules.has(domain),kind:modules.get(domain)?.kind??'missing'
   }))});return;
  }
  if(req.method==='GET'&&!u.search){
   const domain=DOMAINS.find(d=>HEALTH[d]===u.pathname);
   if(domain){
    // M4's health handler calls its rate limiter. Never misrepresent an
    // inert connection pool as actual database readiness.
    if(domain==='users'){
     respond(res,503,{module:'users',sourceLoaded:true,dbReady:false,
      reason:'M4_DATABASE_NOT_COMPOSED'});return;
    }
    const target=modules.get(domain);
    if(target?.kind!=='http'||!target.handler){
     respond(res,503,{error:'M11_MODULE_NOT_READY'});return;
    }
    target.handler(req,res);return;
   }
  }
  // No toggle or token can expose checkout, webhook, wallet, admin or
  // any other domain business route from this staging composition.
  respond(res,503,{error:'M11_BUSINESS_ROUTES_DISABLED',commercialReady:false});
 });
}
export async function assembleIsolatedLab9(input:{
 env:Record<string,string|undefined>,dbUrls:Record<DbKey,string>
}):Promise<LabAssembly>{
 ensureLab(input.env,input.dbUrls);
 const pool=new pg.Pool({connectionString:
  'postgresql://m11_no_access:disabled@127.0.0.1:65534/m11_no_database',
  max:1,connectionTimeoutMillis:250});
 const authenticate=async()=>null;
 const secret=()=>randomBytes(32);
 const configs:Partial<Record<Domain,Record<string,unknown>>>={
  users:{pool,authSecret:secret(),emailSecret:secret(),totpSecret:secret(),
   sendVerification:async()=>{throw new IntegrationError('M11_DELIVERY_DISABLED');}},
  notifications:{pool,deviceSecret:secret(),authenticate},
  restaurants:{pool,authenticate},
  locations:{pool,cipher:null,authenticate},
  payments:{pool,webhookSecret:secret(),authenticate},
  security:{pool,keyring:{},pseudonymKey:secret(),authenticateHost:authenticate},
  analytics:{pool,keys:{orders:{},payments:{},logistics:{}},
   authenticateHost:authenticate}
 };
 const modules=new Map<Domain,Active>();
 try{
  for(const domain of DOMAINS){
   const factory=await loadOwnedFactory(domain);
   const spec=ENTRIES[domain];
   if(spec.kind==='internal'){
    modules.set(domain,{kind:'internal'});continue;
   }
   if(domain==='orders'){
    const app=factory(pool);
    if(typeof app!=='function')
     throw new IntegrationError('M11_FACTORY_INVALID_ORDERS');
    modules.set(domain,{kind:'http',handler:app as Handler});continue;
   }
   const moduleServer=factory(configs[domain]??{});
   modules.set(domain,{kind:'http',
    handler:handlerOf(moduleServer,domain)});
  }
  if(modules.size!==10)throw new IntegrationError('M11_MODULE_MISSING');
  const gateway=healthGateway(modules);
  return {gateway,modules,close:async()=>{
   if(gateway.listening)
    await new Promise<void>((resolve,reject)=>gateway.close(err=>
     err?reject(err):resolve()));
   await pool.end();
  }};
 }catch(err){await pool.end();throw err;}
}
export async function listenIsolatedLab9(assembly:LabAssembly){
 if(process.env.NODE_ENV==='production'||
   process.env.CORE_V2_INTEGRATION_RUNTIME!=='isolated-lab')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 await new Promise<void>((resolve,reject)=>{
  assembly.gateway.listen(0,'127.0.0.1',resolve).once('error',reject);
 });
 const address=assembly.gateway.address();
 if(!address||typeof address==='string'||address.address!=='127.0.0.1')
  throw new IntegrationError('M11_LOOPBACK_ONLY');
 return address.port;
}
