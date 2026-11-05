/** Isolated M9 LAB HTTP gateway adapter: never expose on public interfaces. */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {SecurityError} from './grants.js';
import {authorizeSecurityAction,readSecurityMetrics,type SecurityConfig} from './gate.js';

type Configuration=SecurityConfig&{
 authenticateHost:(req:IncomingMessage)=>Promise<{canMonitorSecurity?:boolean}|null>
};
const LIMIT=4096;
const local=['127.0.0.1','::1','::ffff:127.0.0.1'];
function respond(res:ServerResponse,status:number,body:unknown){
 if(res.headersSent)return;
 const data=Buffer.from(JSON.stringify(body));
 res.writeHead(status,{
  'Content-Type':'application/json; charset=utf-8',
  'Content-Length':String(data.length),
  'Cache-Control':'private, no-store',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'none'"
 });res.end(data);
}
async function readBody(req:IncomingMessage){
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
  req.headers['content-type']??''))
  throw new SecurityError('M9_CONTENT_TYPE_REQUIRED');
 const len=req.headers['content-length'];
 if(len!==undefined&&(!/^\d{1,6}$/.test(len)||Number(len)>LIMIT))
  throw new SecurityError('M9_BODY_TOO_LARGE');
 const chunks:Buffer[]=[];let size=0;
 for await(const part of req){
  const bytes=Buffer.isBuffer(part)?part:Buffer.from(part);
  size+=bytes.length;
  if(size>LIMIT)throw new SecurityError('M9_BODY_TOO_LARGE');
  chunks.push(bytes);
 }
 let value:unknown;
 try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{
  throw new SecurityError('M9_REQUEST_INVALID');
 }
 if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).length!==3||
    Object.keys(value).some(k=>!['grant','action','resourceId'].includes(k)))
  throw new SecurityError('M9_REQUEST_INVALID');
 const o=value as Record<string,unknown>;
 if(typeof o.grant!=='string'||typeof o.action!=='string'||
    typeof o.resourceId!=='string')
  throw new SecurityError('M9_REQUEST_INVALID');
 return {grant:o.grant,action:o.action,resourceId:o.resourceId};
}
export function createSecurityLabHttpServer(config:Configuration){
 if(process.env.NODE_ENV==='production'||!config||
    typeof config.authenticateHost!=='function')
  throw new SecurityError('M9_LAB_HTTP_DISABLED');
 return createServer(async(req,res)=>{
  if(!local.includes(req.socket.remoteAddress??'')||
     !local.includes(req.socket.localAddress??'')){
   respond(res,403,{error:'M9_LOOPBACK_ONLY'});return;
  }
  try{
   const u=new URL(req.url??'/', 'http://127.0.0.1');
   if(u.search||u.hash){respond(res,400,{error:'M9_REQUEST_INVALID'});return;}
   if(req.method==='GET'&&u.pathname==='/v1/security/health'){
    respond(res,200,{module:'security',status:'lab_ready',
     liveProtectionEnabled:false});return;
   }
   if(req.method==='POST'&&u.pathname==='/v1/security/authorize'){
    const input=await readBody(req);
    const result=await authorizeSecurityAction(config,input);
    respond(res,result.allowed?200:result.code==='M9_RATE_LIMITED'?429:
      result.code==='M9_GRANT_REPLAYED'?409:403,result);return;
   }
   if(req.method==='GET'&&u.pathname==='/v1/security/metrics'){
    const caller=await config.authenticateHost(req);
    if(!caller)throw new SecurityError('M9_UNAUTHORIZED');
    respond(res,200,await readSecurityMetrics(config.pool,caller));return;
   }
   respond(res,404,{error:'M9_ROUTE_NOT_FOUND'});
  }catch(e){
   if(e instanceof SecurityError){
    const code=e.code;
    const status=code==='M9_UNAUTHORIZED'||code.startsWith('M9_GRANT_')||
      code==='M9_KEY_INVALID'?401:
     code==='M9_FORBIDDEN'?403:
     code==='M9_CONTENT_TYPE_REQUIRED'?415:
     code==='M9_BODY_TOO_LARGE'?413:400;
    respond(res,status,{error:code});return;
   }
   respond(res,500,{error:'M9_INTERNAL_ERROR'});
  }
 });
}
