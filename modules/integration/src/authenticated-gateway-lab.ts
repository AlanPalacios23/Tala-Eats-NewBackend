/**
 * M11 RC2: authenticating READ-ONLY gateway for the actual M4/M1/M9 host gate.
 *
 * A trusted host must compose this port using createIdentitySecurityLabGate()
 * and createVerifiedM1OwnershipResolver(). Unlike the LAB9 health shell, this
 * makes a real authorization decision over real LAB databases, but it MUST
 * NEVER execute cancellation or be exposed publicly. Until identity is truly
 * unified and all commercial E2E gates are green, LIVE remains disabled.
 */
import {createServer,type Server,type IncomingMessage,type ServerResponse}
 from 'node:http';
import {IntegrationError} from './events.js';

const LOOPBACK=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const BEARER=/^Bearer ([A-Za-z0-9_-]{43})$/;
const ROUTE=/^\/v2\/lab\/orders\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/can-cancel$/i;
const RESTRICTED=['CORE_V2_WRITES_ENABLED','CORE_V2_INTEGRATION_WRITES_ENABLED',
 'CORE_V2_INTEGRATION_LIVE_PAYMENTS_ENABLED',
 'CORE_V2_INTEGRATION_PAYOUTS_ENABLED',
 'CORE_V2_INTEGRATION_PUBLIC_HTTP_ENABLED'] as const;

export type TrustedCancelPort={
 authorizeLabOrderCancel:(input:{sessionToken:string,orderId:string})=>
  Promise<Readonly<{authorized:true,resourceId:string,action:'orders.cancel',
   orderMutationPerformed:false}>>
};
export type AuthGatewayLabInput={
 env:Record<string,string|undefined>,
 cancel:TrustedCancelPort
};
function respond(res:ServerResponse,status:number,value:unknown){
 if(res.headersSent)return;
 const bytes=Buffer.from(JSON.stringify(value));
 res.writeHead(status,{
  'Content-Type':'application/json; charset=utf-8',
  'Content-Length':String(bytes.length),'Cache-Control':'private, no-store',
  'Content-Security-Policy':"default-src 'none'",
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY'
 });
 res.end(bytes);
}
function permittedLab(env:Record<string,string|undefined>){
 if(process.env.NODE_ENV==='production'||env.NODE_ENV==='production'||
    env.CORE_V2_INTEGRATION_RUNTIME!=='isolated-lab'||
    RESTRICTED.some(k=>env[k]==='true'))
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
}
async function handle(req:IncomingMessage,res:ServerResponse,
 port:TrustedCancelPort){
 if(!LOOPBACK.has(req.socket.remoteAddress??'')||
    !LOOPBACK.has(req.socket.localAddress??'')){
  respond(res,403,{error:'M11_LOOPBACK_ONLY'});return;
 }
 if(typeof req.url!=='string'||req.url.length>512||
    !req.url.startsWith('/')||req.url.startsWith('//')){
  respond(res,400,{error:'M11_PATH_INVALID'});return;
 }
 if(req.method==='GET'&&req.url==='/v2/health'){
  respond(res,200,{module:'M11',gateway:'authz-lab',live:false,
   businessEnabled:false,commercialReady:false});return;
 }
 if(req.method==='GET'&&req.url==='/v2/ready'){
  respond(res,503,{ready:false,commercialReady:false});return;
 }
 const matched=req.method==='GET'?ROUTE.exec(req.url):null;
 if(!matched){
  respond(res,503,{error:'M11_BUSINESS_ROUTES_DISABLED'});return;
 }
 if(req.headers.cookie!==undefined||req.headers['x-api-key']!==undefined){
  respond(res,400,{error:'M11_HEADER_NOT_ALLOWED'});return;
 }
 const header=req.headers.authorization??'';
 const m=BEARER.exec(header);
 if(!m){
  respond(res,401,{error:'M11_AUTH_REQUIRED'});return;
 }
 try{
  const orderId=matched[1]!.toLowerCase();
  const decision=await port.authorizeLabOrderCancel({
   sessionToken:m[1]!,orderId});
  if(decision.authorized!==true||decision.resourceId!==orderId||
     decision.action!=='orders.cancel'||decision.orderMutationPerformed!==false)
   throw new IntegrationError('M11_SECURITY_DENIED');
  respond(res,200,{authorized:true,action:'orders.cancel',
   resourceId:orderId,orderMutationPerformed:false,
   commercialReady:false});return;
 }catch(error){
  if(error instanceof IntegrationError){
   const status=error.code==='M11_IDENTITY_NOT_AUTHENTICATED'?401:
    ['M11_CUSTOMER_ROLE_REQUIRED','M11_OWNERSHIP_NOT_VERIFIED',
     'M11_SECURITY_DENIED'].includes(error.code)?403:503;
   respond(res,status,{error:'M11_ACCESS_DENIED'});return;
  }
  // Always fail closed and redact M4/M9/SQL error details.
  respond(res,503,{error:'M11_ACCESS_DENIED'});
 }
}
export function createM11AuthenticatedLabGateway(input:AuthGatewayLabInput):Server{
 permittedLab(input?.env??{});
 if(!input?.cancel||
    typeof input.cancel.authorizeLabOrderCancel!=='function')
  throw new IntegrationError('M11_TRUSTED_GATE_REQUIRED');
 return createServer((req,res)=>{
  void handle(req,res,input.cancel).catch(()=>{
   respond(res,503,{error:'M11_ACCESS_DENIED'});
  });
 });
}
export async function listenM11AuthenticatedLabGateway(server:Server){
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 await new Promise<void>((resolve,reject)=>{
  server.listen(0,'127.0.0.1',resolve).once('error',reject);
 });
 const addr=server.address();
 if(!addr||typeof addr==='string'||addr.address!=='127.0.0.1')
  throw new IntegrationError('M11_LOOPBACK_ONLY');
 return addr.port;
}
