/** M5 providers with injected credentials. No network during CI.
 * Resend can dedupe by delivery ID. FCM may duplicate when a worker dies
 * after a successful send but before its database acknowledgement.
 */
import {NotificationError,uuid} from './domain.js';
import {DeliveryFailure,type EmailMessage,type PushMessage} from './worker.js';
type ProviderFetch=typeof fetch;
function requireConfig(value:unknown){
  if(typeof value!=='string'||value.length<12||/[\s\u0000-\u001f]/.test(value))
    throw new NotificationError('NOTIFICATIONS_PROVIDER_CONFIG_INVALID');
  return value;
}
function emailAddress(value:string){
  if(typeof value!=='string'||value.length>254||
    !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value)||
    value.includes('..'))
    throw new DeliveryFailure('INVALID_VERIFIED_EMAIL',true);
  return value;
}
export function createResendEmailSender({
  apiKey,from,fetchFn=fetch
}:{apiKey:string,from:string,fetchFn?:ProviderFetch}){
  const key=requireConfig(apiKey);
  emailAddress(from);
  if(typeof fetchFn!=='function')
    throw new NotificationError('NOTIFICATIONS_PROVIDER_CONFIG_INVALID');
  return async(message:EmailMessage)=>{
    emailAddress(message.to);
    const response=await fetchFn('https://api.resend.com/emails',{
      method:'POST',headers:{
        Authorization:'Bearer '+key,'Content-Type':'application/json',
        'Idempotency-Key':uuid(message.idempotencyKey)
      },
      body:JSON.stringify({
        from,to:[message.to],subject:message.title,
        text:message.body+'\n\nConsulta la notificación en Tala Eats.',
        tags:[{name:'module',value:'notifications'}]
      }),
      signal:AbortSignal.timeout(8000)
    });
    if(response.ok)return;
    if(response.status===429||response.status>=500)
      throw new DeliveryFailure('EMAIL_PROVIDER_TEMPORARY',false);
    throw new DeliveryFailure('EMAIL_PROVIDER_REJECTED',true);
  };
}
export function createFcmPushSender({
  projectId,getAccessToken,fetchFn=fetch
}:{projectId:string,getAccessToken:()=>Promise<string>,fetchFn?:ProviderFetch}){
  if(typeof projectId!=='string'||!/^[a-z][a-z0-9-]{4,62}$/.test(projectId)||
     typeof getAccessToken!=='function'||typeof fetchFn!=='function')
    throw new NotificationError('NOTIFICATIONS_PROVIDER_CONFIG_INVALID');
  return async(message:PushMessage)=>{
    const bearer=await getAccessToken();
    if(typeof bearer!=='string'||bearer.length<16||
      /[\s\u0000-\u001f]/.test(bearer))
      throw new DeliveryFailure('FCM_AUTH_UNAVAILABLE',false);
    const msg:Record<string,unknown>={
      token:message.token,
      notification:{title:message.title,body:message.body},
      data:{
        notificationId:message.notificationId,
        eventType:message.eventType,
        deepLink:message.deepLink,
        app:message.app,
        ...(message.data.resourceId?{resourceId:message.data.resourceId}:{})
      }
    };
    if(message.platform==='android')
      msg.android={priority:'high'};
    else if(message.platform==='ios')
      msg.apns={headers:{'apns-priority':'10'},payload:{aps:{sound:'default'}}};
    else
      msg.webpush={headers:{Urgency:'high'}};
    const response=await fetchFn(
      'https://fcm.googleapis.com/v1/projects/'+projectId+'/messages:send',{
        method:'POST',headers:{
          Authorization:'Bearer '+bearer,'Content-Type':'application/json'
        },
        body:JSON.stringify({message:msg}),
        signal:AbortSignal.timeout(8000)
      });
    if(response.ok)return;
    if(response.status===429||response.status>=500||
       response.status===401||response.status===403)
      throw new DeliveryFailure('FCM_TEMPORARY_OR_CONFIG',false);
    throw new DeliveryFailure('FCM_INVALID_RECIPIENT',true);
  };
}
