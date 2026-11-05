/** M11 read-only composition shell. Never mount domain LAB write routes here.
 * Production gateway must be separately security-reviewed and E2E-approved.
 */
import {createServer} from 'node:http';
import {checkIntegrationAdmission,type DbKey} from './admission.js';
import {IntegrationError} from './events.js';

const LOOPBACK=['127.0.0.1','::1','::ffff:127.0.0.1'];
const MODULES=['orders','logistics','finance','users','notifications',
 'restaurants','locations','payments','security','analytics'] as const;
export function createIntegrationLabHttpServer(input:{
 env:Record<string,string|undefined>,dbUrls:Record<DbKey,string>
}){
 const allowed=checkIntegrationAdmission(input.env,input.dbUrls);
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 return createServer((req,res)=>{
  if(!LOOPBACK.includes(req.socket.localAddress??'')||
    !LOOPBACK.includes(req.socket.remoteAddress??'')){
   res.writeHead(403,{'Cache-Control':'no-store'});res.end();return;
  }
  const response=(code:number,body:unknown)=>{
   const bytes=Buffer.from(JSON.stringify(body));
   res.writeHead(code,{'Content-Type':'application/json; charset=utf-8',
    'Content-Length':String(bytes.length),'Cache-Control':'private, no-store',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
   res.end(bytes);
  };
  if(req.method==='GET'&&req.url==='/v1/integration/health'){
   response(200,{module:'M11',runtime:'isolated-lab',
    tenSourcesAssembled:true,commercialReady:false,
    tenRealPortsConnected:false,stagingSingleProcessReady:false});return;
  }
  if(req.method==='GET'&&req.url==='/v1/integration/modules'){
   response(200,{...allowed,
    modules:MODULES.map((name,i)=>({id:'M'+(i+1),name,
     sourceCopied:true,productionIntegrated:false}))});return;
  }
  response(404,{error:'M11_ROUTE_NOT_FOUND'});
 });
}
