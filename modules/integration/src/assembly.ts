/** M11 real-code single-process LAB composition.
 *
 * Each of M1-M10 is loaded from a SHA-pinned sibling Git worktree. M1/M2
 * share the same descendant checkout; M3 and M2 remain private workers.
 * The LAB entrypoint intentionally exposes **only health**.  Business
 * operations cannot be made public until M4/M9 identity, M1/M8/M3 accounting
 * and all cross-module invariants are proven in staging. NO PROD SERVER.
 */
import {createServer,Server,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomBytes} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {DOMAINS,ENTRYPOINTS,IntegrationError,
 type Domain,type Manifest,verifyCheckoutRevisions} from './manifest.js';

export type ActiveModule={domain:Domain,kind:'http'|'internal',
 moduleExport:string,source:string,sha:string,
 handler?: (req:IncomingMessage,res:ServerResponse)=>void};
export type LabAssembly={
 manifest:Manifest,
 modules:ReadonlyMap<Domain,ActiveModule>,
 gateway:Server,
 close:()=>Promise<void>
};
const HEALTH:Partial<Record<Domain,string>>={
 orders:'/api/v2/health',
 users:'/v1/users/health',
 notifications:'/v1/notifications/health',
 restaurants:'/v1/restaurants/health',
 locations:'/v1/locations/health',
 payments:'/v1/payments/health',
 security:'/v1/security/health',
 analytics:'/v1/analytics/health'
};
const LOOPBACK=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
function respond(res:ServerResponse,status:number,body:unknown){
 if(res.headersSent)return;
 const bytes=Buffer.from(JSON.stringify(body));
 res.writeHead(status,{
  'Content-Type':'application/json; charset=utf-8',
  'Content-Length':String(bytes.length),
  'Cache-Control':'private, no-store',
  'Content-Security-Policy':"default-src 'none'",
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer'
 });res.end(bytes);
}
type Factory=(config:Record<string,unknown>)=>unknown;
async function importFunction(root:string,domain:Domain):Promise<Factory>{
 const entry=ENTRYPOINTS[domain];
 const file=join(root,entry.source,entry.file);
 let module:Record<string,unknown>;
 try{
  module=await import(pathToFileURL(file).href) as Record<string,unknown>;
 }catch{
  // Don't leak upstream paths or loader details to public clients.
  throw new IntegrationError('M11_MODULE_IMPORT_FAILED_'+domain.toUpperCase());
 }
 const result=module[entry.exportName];
 if(typeof result!=='function')
  throw new IntegrationError('M11_MODULE_EXPORT_MISSING_'+domain.toUpperCase());
 return result as Factory;
}
function serverHandler(value:unknown,domain:Domain):
 (req:IncomingMessage,res:ServerResponse)=>void{
 if(!(value instanceof Server)||value.listening)
  throw new IntegrationError('M11_HTTP_FACTORY_INVALID_'+domain.toUpperCase());
 const listeners=value.listeners('request');
 if(listeners.length!==1)
  throw new IntegrationError('M11_HTTP_FACTORY_INVALID_'+domain.toUpperCase());
 // Delegate to the original module's real handler without opening another
 // port, so all domain health endpoints run inside one Node HTTP process.
 return (req,res)=>{
  value.emit('request',req,res);
 };
}
function createGate(modules:ReadonlyMap<Domain,ActiveModule>):Server{
 const server=createServer((req,res)=>{
  if(!LOOPBACK.has(req.socket.remoteAddress??'')||
   !LOOPBACK.has(req.socket.localAddress??'')){
   respond(res,403,{error:'M11_LOOPBACK_ONLY'});return;
  }
  if(typeof req.url!=='string'||!req.url.startsWith('/')||
    req.url.startsWith('//')||req.url.length>2048){
   respond(res,400,{error:'M11_PATH_INVALID'});return;
  }
  let url:URL;
  try{url=new URL(req.url,'http://127.0.0.1');}
  catch{respond(res,400,{error:'M11_PATH_INVALID'});return;}
  if(req.method==='GET'&&!url.search&&url.pathname==='/v2/health'){
   respond(res,200,{service:'tala-eats-core-v2',
    module:'integration',version:'M11-LAB1',status:'assembly_lab',
    domainsLoaded:modules.size,
    businessEnabled:false,commercialReady:false});return;
  }
  if(req.method==='GET'&&!url.search&&url.pathname==='/v2/ready'){
   respond(res,503,{ready:false,
    reason:'INTEGRATION_BUSINESS_CONTRACTS_NOT_VALIDATED',
    domainsLoaded:modules.size,commercialReady:false});return;
  }
  if(req.method==='GET'&&!url.search&&url.pathname==='/v2/modules'){
   respond(res,200,{
    commercialReady:false,
    modules:DOMAINS.map(domain=>({
     domain,kind:modules.get(domain)?.kind??'missing',
     loaded:modules.has(domain)
    }))
   });return;
  }
  if(req.method==='GET'&&!url.search){
   const found=DOMAINS.find(d=>HEALTH[d]===url.pathname);
   if(found){
    const target=modules.get(found);
    if(target?.kind!=='http'||!target.handler){
     respond(res,503,{error:'M11_MODULE_NOT_READY'});return;
    }
    target.handler(req,res);
    return;
   }
  }
  // This rule is deliberately *unconditional*. No env toggle,
  // header or bearer token can enable real writes here.
  respond(res,503,{error:'M11_BUSINESS_ROUTES_DISABLED',
   commercialReady:false});
 });
 return server;
}
export async function assembleLabMonolith(manifest:Manifest,
 sourceRoot:string):Promise<LabAssembly>{
 if(process.env.NODE_ENV==='production'||
    process.env.M11_RUNTIME!=='isolated-lab')
  throw new IntegrationError('M11_LAB_ONLY');
 const root=resolve(sourceRoot);
 const pinned=await verifyCheckoutRevisions(root,manifest);
 const pool=new pg.Pool({
  // Inert pool. No module will make SQL requests because only health
  // endpoints are reachable through the M11 gateway.
  connectionString:'postgresql://m11_no_access:disabled@127.0.0.1:65534/m11_no_database',
  max:1,connectionTimeoutMillis:250
 });
 const nullIdentity=async()=>null;
 const factories=new Map<Domain,Factory>();
 const modules=new Map<Domain,ActiveModule>();
 try{
  for(const domain of DOMAINS)
   factories.set(domain,await importFunction(root,domain));
  const secrets=()=>{
   const key=randomBytes(32);
   return key;
  };
  // All factories are the original, SHA-pinned modules. M11 does not
  // copy their implementation or change module-owned business logic.
  const configs:Partial<Record<Domain,Record<string,unknown>>>={
   users:{pool,authSecret:secrets(),emailSecret:secrets(),
    totpSecret:secrets(),sendVerification:async()=>{
     throw new IntegrationError('M11_EMAIL_DELIVERY_DISABLED');
    }},
   notifications:{pool,deviceSecret:secrets(),authenticate:nullIdentity},
   restaurants:{pool,authenticate:nullIdentity},
   locations:{pool,cipher:null,authenticate:nullIdentity},
   payments:{pool,webhookSecret:secrets(),authenticate:nullIdentity},
   security:{pool,keyring:{},pseudonymKey:secrets(),
    authenticateHost:nullIdentity},
   analytics:{pool,keys:{orders:{},payments:{},logistics:{}},
    authenticateHost:nullIdentity}
  };
  for(const domain of DOMAINS){
   const entry=ENTRYPOINTS[domain];
   const sha=pinned[entry.source];
   if(!sha)throw new IntegrationError('M11_MODULE_MISSING');
   const common={domain,kind:entry.kind,moduleExport:entry.exportName,
    source:entry.source,sha} as const;
   if(entry.kind==='internal'){
    modules.set(domain,common);
    continue;
   }
   if(domain==='orders'){
    const orderApp=factories.get('orders')!(pool) as unknown;
    if(typeof orderApp!=='function')
     throw new IntegrationError('M11_HTTP_FACTORY_INVALID_ORDERS');
    modules.set(domain,{...common,
     handler:(req,res)=>(orderApp as
      (req:IncomingMessage,res:ServerResponse)=>void)(req,res)});
    continue;
   }
   const originalServer=factories.get(domain)!(configs[domain]??{});
   modules.set(domain,{...common,
    handler:serverHandler(originalServer,domain)});
  }
  if(modules.size!==10)throw new IntegrationError('M11_MODULE_MISSING');
  const gateway=createGate(modules);
  return {manifest,modules,gateway,close:async()=>{
   if(gateway.listening)
    await new Promise<void>((yes,no)=>gateway.close(e=>e?no(e):yes()));
   await pool.end();
  }};
 }catch(err){await pool.end();throw err;}
}
export async function listenLocalOnly(assembly:LabAssembly):Promise<number>{
 if(process.env.NODE_ENV==='production'||
    process.env.M11_RUNTIME!=='isolated-lab')
  throw new IntegrationError('M11_LAB_ONLY');
 await new Promise<void>((ok,fail)=>
  assembly.gateway.listen(0,'127.0.0.1',()=>{
   ok();
  }).once('error',fail));
 const addr=assembly.gateway.address();
 if(!addr||typeof addr==='string'||addr.address!=='127.0.0.1')
  throw new IntegrationError('M11_LOOPBACK_ONLY');
 return addr.port;
}
