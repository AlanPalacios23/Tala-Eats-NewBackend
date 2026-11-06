/** M10 self-contained loopback LAB API. Not an internet-facing REST API.
 * No checkout, payouts, customer identity, device tracking, or PII.
 */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {AnalyticsError,type Issuer} from './contract.js';
import {ingestAnalyticsEvent,merchantAnalytics,platformAnalytics,
 type AnalyticsConfig,type AnalyticsActor} from './analytics.js';
type Config=AnalyticsConfig&{
 authenticateHost:(req:IncomingMessage)=>Promise<AnalyticsActor|null>
};
const MAX=8192;
const LOOPBACK=['127.0.0.1','::1','::ffff:127.0.0.1'];
function respond(res:ServerResponse,status:number,body:unknown){
 if(res.headersSent)return;
 const bytes=Buffer.from(JSON.stringify(body));
 res.writeHead(status,{
  'Content-Type':'application/json; charset=utf-8',
  'Content-Length':String(bytes.length),'Cache-Control':'private, no-store',
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'none'"
 });res.end(bytes);
}
async function readRaw(req:IncomingMessage){
 const mime=req.headers['content-type'];
 if(typeof mime!=='string'||
  !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(mime))
  throw new AnalyticsError('M10_CONTENT_TYPE_REQUIRED');
 const length=req.headers['content-length'];
 if(length!==undefined&&(!/^\d{1,5}$/.test(length)||
    Number(length)>MAX))
  throw new AnalyticsError('M10_BODY_TOO_LARGE');
 const chunks:Buffer[]=[];let count=0;
 for await(const c of req){
  const chunk=Buffer.isBuffer(c)?c:Buffer.from(c);
  count+=chunk.length;
  if(count>MAX)throw new AnalyticsError('M10_BODY_TOO_LARGE');
  chunks.push(chunk);
 }
 return Buffer.concat(chunks);
}
function range(u:URL){
 const entries=Array.from(u.searchParams.keys());
 if(entries.length!==2||entries.sort().join(',')!=='from,to')
  throw new AnalyticsError('M10_REPORT_RANGE_INVALID');
 const from=u.searchParams.get('from'),to=u.searchParams.get('to');
 if(!from||!to)throw new AnalyticsError('M10_REPORT_RANGE_INVALID');
 return {from,to};
}
export function createAnalyticsLabHttpServer(config:Config){
 if(!config||typeof config.authenticateHost!=='function'||
   process.env.NODE_ENV==='production')
  throw new AnalyticsError('M10_LAB_HTTP_DISABLED');
 return createServer(async(req,res)=>{
  if(!LOOPBACK.includes(req.socket.localAddress??'')||
     !LOOPBACK.includes(req.socket.remoteAddress??'')){
   respond(res,403,{error:'M10_LOOPBACK_ONLY'});return;
  }
  try{
   const u=new URL(req.url??'/', 'http://127.0.0.1');
   const method=req.method??'';
   if(method==='GET'&&u.pathname==='/v1/analytics/health'&&!u.search){
    respond(res,200,{module:'analytics',status:'lab_ready',
     commercialAnalyticsEnabled:false});return;
   }
   if(method==='POST'&&u.pathname==='/v1/analytics/events'&&!u.search){
    const issuer=req.headers['x-m10-issuer'];
    const kid=req.headers['x-m10-key-id'];
    const signature=req.headers['x-m10-signature'];
    if((issuer!=='orders'&&issuer!=='payments'&&issuer!=='logistics')||
     typeof kid!=='string'||typeof signature!=='string')
     throw new AnalyticsError('M10_ISSUER_UNTRUSTED');
    const raw=await readRaw(req);
    const result=await ingestAnalyticsEvent(config,{
     issuer:issuer as Issuer,kid,signature,raw});
    respond(res,result.duplicate?200:201,result);return;
   }
   const merchant=u.pathname.match(/^\/v1\/analytics\/merchant\/([0-9a-f-]{36})$/i);
   if(method==='GET'&&merchant){
    const viewer=await config.authenticateHost(req);
    if(!viewer)throw new AnalyticsError('M10_UNAUTHORIZED');
    const v=range(u);
    respond(res,200,await merchantAnalytics(config.pool,viewer,merchant[1]!,
      v.from,v.to));return;
   }
   if(method==='GET'&&u.pathname==='/v1/analytics/platform'){
    const viewer=await config.authenticateHost(req);
    if(!viewer)throw new AnalyticsError('M10_UNAUTHORIZED');
    const v=range(u);
    respond(res,200,await platformAnalytics(config.pool,viewer,v.from,v.to));
    return;
   }
   respond(res,404,{error:'M10_ROUTE_NOT_FOUND'});
  }catch(e){
   if(e instanceof AnalyticsError){
    const code=e.code;
    const status=code==='M10_UNAUTHORIZED'||
      code==='M10_SIGNATURE_INVALID'||code==='M10_SIGNATURE_EXPIRED'||
      code==='M10_ISSUER_UNTRUSTED'||code==='M10_KEY_INVALID'?401:
      code==='M10_FORBIDDEN'||code==='M10_ISSUER_SCOPE_INVALID'?403:
      code==='M10_CONTENT_TYPE_REQUIRED'?415:
      code==='M10_BODY_TOO_LARGE'||code==='M10_PAYLOAD_INVALID'?413:
      code.includes('CONFLICT')||code==='M10_MISSING_PAYMENT_FACT'||
       code==='M10_REFUND_EXCEEDS_CAPTURE'?409:400;
    respond(res,status,{error:code});return;
   }
   respond(res,500,{error:'M10_INTERNAL_ERROR'});
  }
 });
}
