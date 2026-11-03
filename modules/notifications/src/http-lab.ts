/** M5 loopback-only HTTP LAB adapter. Not deployable as a public service.
 * Identity is INJECTED by a trusted host. Never accept client-provided
 * recipientId/app as authentication. Production requires TLS+real auth.
 */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {Pool} from 'pg';
import {NotificationError,uuid,appValue,type App} from './domain.js';
import {readInbox,markNotificationRead,markAllNotificationsRead,
  dismissNotification} from './store.js';
import {registerDevice,listRecipientDevices,revokeRecipientDevice,
  setRecipientPreference,readRecipientPreferences} from './recipients.js';
import type {Platform} from './crypto.js';

export type VerifiedNotificationIdentity={recipientId:string,app:App};
export type NotificationsLabConfig={
  pool:Pool,deviceSecret:Buffer,
  authenticate:(request:IncomingMessage)=>Promise<VerifiedNotificationIdentity|null>
};
const MAX_BODY=12288;
function obj(v:unknown,fields:readonly string[]){
  if(!v||typeof v!=='object'||Array.isArray(v)||
     Object.keys(v).some(k=>!fields.includes(k)))
    throw new NotificationError('NOTIFICATIONS_REQUEST_INVALID');
  return v as Record<string,unknown>;
}
function textValue(v:unknown){
  if(typeof v!=='string')throw new NotificationError('NOTIFICATIONS_REQUEST_INVALID');
  return v;
}
function boolValue(v:unknown){
  if(typeof v!=='boolean')throw new NotificationError('NOTIFICATIONS_REQUEST_INVALID');
  return v;
}
async function body(req:IncomingMessage){
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
    req.headers['content-type']??''))
    throw new NotificationError('NOTIFICATIONS_CONTENT_TYPE_REQUIRED');
  const declared=Number(req.headers['content-length']??0);
  if(!Number.isFinite(declared)||declared<0||declared>MAX_BODY)
    throw new NotificationError('NOTIFICATIONS_PAYLOAD_TOO_LARGE');
  let size=0;const chunks:Buffer[]=[];
  for await(const part of req){
    const b=Buffer.isBuffer(part)?part:Buffer.from(part);
    size+=b.length;
    if(size>MAX_BODY)throw new NotificationError('NOTIFICATIONS_PAYLOAD_TOO_LARGE');
    chunks.push(b);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
  catch{throw new NotificationError('NOTIFICATIONS_REQUEST_INVALID');}
}
function reply(res:ServerResponse,status:number,value:unknown){
  if(res.headersSent)return;
  const output=JSON.stringify(value);
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Content-Length':Buffer.byteLength(output),
    'Cache-Control':'private, no-store',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'"
  });
  res.end(output);
}
export function createNotificationsLabHttpServer({
  pool,deviceSecret,authenticate
}:NotificationsLabConfig){
  if(process.env.NODE_ENV==='production'||!Buffer.isBuffer(deviceSecret)||
     deviceSecret.length<32||typeof authenticate!=='function')
    throw new NotificationError('NOTIFICATIONS_LAB_HTTP_DISABLED');
  return createServer(async(req,res)=>{
    if(req.socket.localAddress!=='127.0.0.1'&&req.socket.localAddress!=='::1'){
      reply(res,403,{error:'NOTIFICATIONS_LOOPBACK_ONLY'});return;
    }
    let url:URL;
    try{url=new URL(req.url??'/', 'http://127.0.0.1');}
    catch{reply(res,400,{error:'NOTIFICATIONS_REQUEST_INVALID'});return;}
    const route=url.pathname,method=req.method??'';
    try{
      if(route==='/v1/notifications/health'&&method==='GET'){
        reply(res,200,{module:'notifications',status:'lab_ready'});return;
      }
      const verified=await authenticate(req);
      if(!verified)throw new NotificationError('NOTIFICATIONS_UNAUTHORIZED');
      const recipientId=uuid(verified.recipientId),app=appValue(verified.app);
      const context={recipientId,app};
      if(route==='/v1/notifications'&&method==='GET'){
        if([...url.searchParams.keys()].some(k=>!['limit','before'].includes(k)))
          throw new NotificationError('NOTIFICATIONS_PAGE_INVALID');
        const count=url.searchParams.get('limit');
        const limit=count===null?20:Number(count);
        const before=url.searchParams.get('before');
        reply(res,200,await readInbox(pool,{
          ...context,limit,...(before?{beforeId:before}:{})
        }));return;
      }
      if(route==='/v1/notifications/read'&&method==='POST'){
        const d=obj(await body(req),['notificationId']);
        reply(res,200,await markNotificationRead(pool,{
          ...context,notificationId:textValue(d.notificationId)
        }));return;
      }
      if(route==='/v1/notifications/read-all'&&method==='POST'){
        obj(await body(req),[]);
        reply(res,200,await markAllNotificationsRead(pool,context));return;
      }
      if(route==='/v1/notifications/dismiss'&&method==='POST'){
        const d=obj(await body(req),['notificationId']);
        reply(res,200,await dismissNotification(pool,{
          ...context,notificationId:textValue(d.notificationId)
        }));return;
      }
      if(route==='/v1/notifications/preferences'&&method==='GET'){
        reply(res,200,await readRecipientPreferences(pool,context));return;
      }
      if(route==='/v1/notifications/preferences'&&method==='PUT'){
        const d=obj(await body(req),['channel','category','enabled']);
        reply(res,200,await setRecipientPreference(pool,{
          ...context,
          channel:textValue(d.channel) as 'in_app'|'email'|'push',
          category:textValue(d.category) as 'transactional'|'marketing',
          enabled:boolValue(d.enabled)
        }));return;
      }
      if(route==='/v1/notifications/devices'&&method==='GET'){
        reply(res,200,await listRecipientDevices(pool,context));return;
      }
      if(route==='/v1/notifications/devices'&&method==='POST'){
        const d=obj(await body(req),['platform','token']);
        reply(res,201,await registerDevice(pool,{
          ...context,platform:textValue(d.platform) as Platform,
          token:textValue(d.token),secret:deviceSecret
        }));return;
      }
      if(route==='/v1/notifications/devices/revoke'&&method==='POST'){
        const d=obj(await body(req),['deviceId']);
        reply(res,200,await revokeRecipientDevice(pool,{
          ...context,deviceId:textValue(d.deviceId)
        }));return;
      }
      reply(res,404,{error:'NOTIFICATIONS_ROUTE_NOT_FOUND'});
    }catch(error){
      if(error instanceof NotificationError){
        const code=error.code;
        const status=code==='NOTIFICATIONS_UNAUTHORIZED'?401:
          code==='NOTIFICATIONS_CONTENT_TYPE_REQUIRED'?415:
          code==='NOTIFICATIONS_PAYLOAD_TOO_LARGE'?413:
          code.includes('CONFLICT')?409:400;
        reply(res,status,{error:code});return;
      }
      reply(res,500,{error:'NOTIFICATIONS_INTERNAL_ERROR'});
    }
  });
}
