/**
 * M4 only: transactional identity email transport via Resend REST.
 * No provider credentials in Git. NO real email is sent by CI.
 * Configure a verified sender, API key and HTTPS frontend URLs explicitly.
 * Caller may inject this pair into createUsersLabHttpServer only after
 * separate secure gateway and production threat review.
 */
import {createHash} from 'node:crypto';
import {canonicalEmail,requireUserId,UsersError} from './domain.js';
type Kind='verify-email'|'reset-password';
type SendFunction=(to:string,token:string,userId:string)=>Promise<void>;
export type MailFetch=typeof fetch;
type MailSettings={
  apiKey:string;
  from:string;
  verificationPage:string;
  recoveryPage:string;
  fetchFn?:MailFetch;
};
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const key=(type:Kind,id:string,token:string)=>
  createHash('sha256').update('tala.users.email.v1|'+type+'|'+id+'|'+token)
    .digest('hex');
function requireHttpsUrl(raw:string){
  let url:URL;
  try{url=new URL(raw);}catch{throw new UsersError('USERS_MAIL_CONFIG_INVALID');}
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password||
     url.hash||url.search||!['443',''].includes(url.port))
    throw new UsersError('USERS_MAIL_CONFIG_INVALID');
  return url;
}
/** No mutable display fields from a user are injected into the message. */
export function createResendMailSinks({
  apiKey,from,verificationPage,recoveryPage,fetchFn=fetch
}:MailSettings):{sendVerification:SendFunction,sendPasswordReset:SendFunction}{
  if(typeof apiKey!=='string'||apiKey.length<12||
     /[\s\u0000-\u001f]/.test(apiKey)||typeof fetchFn!=='function')
    throw new UsersError('USERS_MAIL_CONFIG_INVALID');
  const sender=canonicalEmail(from);
  const verify=requireHttpsUrl(verificationPage);
  const reset=requireHttpsUrl(recoveryPage);
  async function send(kind:Kind,to:string,token:string,userId:string){
    const recipient=canonicalEmail(to),id=requireUserId(userId);
    if(typeof token!=='string'||!TOKEN.test(token))
      throw new UsersError('USERS_MAIL_TOKEN_INVALID');
    const page=new URL(kind==='verify-email'?verify:reset);
    // Link fragment stays out of HTTP requests, referrals and server access
    // logs; frontend should immediately clear it after parsing.
    page.hash=new URLSearchParams({userId:id,token}).toString();
    const subject=kind==='verify-email'
      ?'Confirma tu correo — Tala Eats'
      :'Restablece tu contraseña — Tala Eats';
    const text=kind==='verify-email'
      ?'Confirma tu correo en los próximos 10 minutos: '
      :'Restablece tu contraseña en los próximos 10 minutos: ';
    const message=text+page.toString();
    const eventKey=key(kind,id,token);
    // Same key on retries means a provider retry does not duplicate mail.
    for(let attempt=0;attempt<3;attempt++){
      let response:Response;
      try{
        response=await fetchFn('https://api.resend.com/emails',{
          method:'POST',
          headers:{
            'Authorization':'Bearer '+apiKey,
            'Content-Type':'application/json',
            'Idempotency-Key':eventKey
          },
          body:JSON.stringify({
            from:sender,to:[recipient],subject,
            text:message,
            html:'<p>Tala Eats</p><p><a href="'+
              page.toString().replaceAll('&','&amp;')+
              '">Continuar de forma segura</a></p><p>Válido 10 minutos.</p>'
          }),
          signal:AbortSignal.timeout(8000)
        });
      }catch{
        if(attempt===2)throw new UsersError('USERS_MAIL_DELIVERY_FAILED');
        await new Promise(resolve=>setTimeout(resolve,200*(attempt+1)));
        continue;
      }
      if(response.ok){
        try{
          const result=await response.json() as {id?:unknown};
          if(typeof result?.id==='string'&&result.id.length>0)return;
        }catch{/* no response payload returned to client */}
        throw new UsersError('USERS_MAIL_DELIVERY_FAILED');
      }
      if(attempt===2||!(response.status===429||response.status>=500))
        throw new UsersError('USERS_MAIL_DELIVERY_FAILED');
      await new Promise(resolve=>setTimeout(resolve,200*(attempt+1)));
    }
    throw new UsersError('USERS_MAIL_DELIVERY_FAILED');
  }
  return {
    sendVerification:(to,token,id)=>send('verify-email',to,token,id),
    sendPasswordReset:(to,token,id)=>send('reset-password',to,token,id)
  };
}
