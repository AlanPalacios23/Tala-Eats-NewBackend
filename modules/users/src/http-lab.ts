import {consumeLabRequestQuota} from './rate-limit.js';
/**
 * M4 Usuarios — loopback-only HTTP LAB adapter for end-to-end tests.
 *
 * NEVER bind to a public interface, never deploy directly. Verification
 * delivery is injected; the raw token is NEVER in HTTP responses.
 * Authentication is a bearer token, no browser cookies/CSRF endpoints.
 * Production needs its own TLS gateway, threat model, real mail service,
 * distributed rate limiter, observability and RBAC.
 */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {Pool} from 'pg';
import {UsersError} from './domain.js';
import {issueLabEmailChallenge,issueLabEmailChallengeForAddress,
  verifyLabEmailChallenge} from './store.js';
import {
  listMyAddresses,saveMyAddress,updateMyAddress,
  setMyDefaultAddress,deleteMyAddress,readMyPreferences,
  updateMyPreferences,exportMyData,type AddressInput
} from './private-profile.js';
import {registerCredentialedPendingUser,loginLabUser,
  readAuthenticatedProfile,logoutLabSession,updateAuthenticatedProfile,
  changeAuthenticatedPassword,requestAuthenticatedDeletion,
  issueLabPasswordRecovery,resetLabPassword,listAuthenticatedSessions,
  revokeAuthenticatedSession,revokeOtherAuthenticatedSessions,
  beginLabTotpEnrollment,confirmLabTotpEnrollment,
  readMyIdentityRole} from './auth.js';

type VerificationSink=(email:string,token:string,userId:string)=>Promise<void>;
export type UsersLabHttpConfig={
  pool:Pool;
  authSecret:Buffer;
  emailSecret:Buffer;
  totpSecret?:Buffer;
  sendVerification:VerificationSink;
  sendPasswordReset?:(email:string,token:string,userId:string)=>Promise<void>;
};
const VALID_BEARER=/^Bearer ([A-Za-z0-9_-]{43})$/;
const MAX_BYTES=16384;
function fields(value:unknown,names:readonly string[]):Record<string,unknown>{
  if(value===null||typeof value!=='object'||Array.isArray(value)||
     Object.keys(value).some(k=>!names.includes(k)))
    throw new UsersError('USERS_REQUEST_INVALID');
  return value as Record<string,unknown>;
}
function string(value:unknown):string{
  if(typeof value!=='string')throw new UsersError('USERS_REQUEST_INVALID');
  return value;
}
function integer(value:unknown):number{
  if(!Number.isSafeInteger(value)||typeof value!=='number')
    throw new UsersError('USERS_REQUEST_INVALID');
  return value;
}
async function readBody(req:IncomingMessage):Promise<unknown>{
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
    req.headers['content-type']??''))
    throw new UsersError('USERS_CONTENT_TYPE_REQUIRED');
  const declared=Number(req.headers['content-length']??0);
  if(declared>MAX_BYTES)throw new UsersError('USERS_PAYLOAD_TOO_LARGE');
  let size=0;
  const chunks:Buffer[]=[];
  for await(const chunk of req){
    const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=value.length;
    if(size>MAX_BYTES)throw new UsersError('USERS_PAYLOAD_TOO_LARGE');
    chunks.push(value);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw new UsersError('USERS_REQUEST_INVALID');}
}
function bearer(req:IncomingMessage):string{
  const header=req.headers.authorization??'';
  const match=VALID_BEARER.exec(header);
  if(!match?.[1])throw new UsersError('USERS_SESSION_INVALID');
  return match[1];
}
function reply(res:ServerResponse,status:number,value:unknown){
  if(res.headersSent)return;
  const body=JSON.stringify(value);
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Content-Length':Buffer.byteLength(body),
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'"
  });
  res.end(body);
}
function errorStatus(error:UsersError):number{
  const code=error.code;
  if(code==='USERS_INVALID_CREDENTIALS'||code==='USERS_SESSION_INVALID'||
     code==='USERS_VERIFICATION_INVALID'||code==='USERS_RECOVERY_INVALID'||
     code==='USERS_NOT_FOUND')
    return 401;
  if(code==='USERS_MFA_REQUIRED'||code==='USERS_TOTP_INVALID')
    return 401;
  if(code==='USERS_ROLE_DENIED')return 403;
  if(code==='USERS_RATE_LIMITED'||code==='USERS_VERIFICATION_COOLDOWN')
    return 429;
  if(code==='USERS_PAYLOAD_TOO_LARGE')return 413;
  if(code==='USERS_CONTENT_TYPE_REQUIRED')return 415;
  if(code.includes('CONFLICT')||code.includes('UNCHANGED')||
     code==='USERS_PASSWORD_REUSE')return 409;
  if(code==='USERS_AUTH_CONFIG_INVALID'||code==='USERS_LAB_ONLY')
    return 503;
  return 400;
}
export function createUsersLabHttpServer({
  pool,authSecret,emailSecret,totpSecret,sendVerification,sendPasswordReset
}:UsersLabHttpConfig){
  if(process.env.NODE_ENV==='production'||
     !Buffer.isBuffer(authSecret)||authSecret.length<32||
     !Buffer.isBuffer(emailSecret)||emailSecret.length<32||
     typeof sendVerification!=='function')
    throw new UsersError('USERS_LAB_HTTP_DISABLED');
  return createServer(async(req,res)=>{
    const local=req.socket.localAddress??'';
    if(local!=='127.0.0.1'&&local!=='::1'){
      reply(res,403,{error:'USERS_LOOPBACK_ONLY'});
      return;
    }
    const route=(req.url??'').split('?')[0]??'';
    const method=req.method??'';
    try{
      const sensitive=['/v1/users/register','/v1/users/login',
        '/v1/users/resend-verification','/v1/users/verify-email',
        '/v1/users/forgot-password','/v1/users/reset-password'];
      await consumeLabRequestQuota(pool,{
        remoteAddress:req.socket.remoteAddress??'unknown',method,route,
        secret:authSecret,limit:sensitive.includes(route)?15:100
      });
      if(method==='GET'&&route==='/v1/users/health'){
        reply(res,200,{status:'lab_ready',module:'users'});
        return;
      }
      if(method==='POST'&&route==='/v1/users/register'){
        const d=fields(await readBody(req),[
          'email','displayName','password','idempotencyKey']);
        const result=await registerCredentialedPendingUser(pool,{
          email:string(d.email),displayName:string(d.displayName),
          password:string(d.password),idempotencyKey:string(d.idempotencyKey),
          secret:authSecret
        });
        // On a safe replay, an existing challenge is not reissued.
        // Explicit resend with a proper throttle is future work.
        if(!result.replayed){
          const proof=await issueLabEmailChallenge(pool,{
            userId:result.user.id,secret:emailSecret
          });
          await sendVerification(result.user.email,proof.token,result.user.id);
        }
        reply(res,202,{userId:result.user.id,status:'pending_verification',
          replayed:result.replayed});
        return;
      }
      if(method==='POST'&&route==='/v1/users/resend-verification'){
        const d=fields(await readBody(req),['email']);
        const proof=await issueLabEmailChallengeForAddress(pool,{
          email:string(d.email),secret:emailSecret
        });
        if(proof)await sendVerification(proof.email,proof.token,proof.userId);
        // No indication whether an account exists, is verified or cooling down.
        reply(res,202,{accepted:true});
        return;
      }
      if(method==='POST'&&route==='/v1/users/verify-email'){
        const d=fields(await readBody(req),[
          'userId','token','expectedVersion','idempotencyKey']);
        const result=await verifyLabEmailChallenge(pool,{
          userId:string(d.userId),actorId:string(d.userId),
          token:string(d.token),secret:emailSecret,
          expectedVersion:integer(d.expectedVersion),
          idempotencyKey:string(d.idempotencyKey)
        });
        reply(res,200,{userId:result.user.id,status:result.user.status,
          replayed:result.replayed});
        return;
      }
      if(method==='POST'&&route==='/v1/users/login'){
        const d=fields(await readBody(req),['email','password','totpCode']);
        const result=await loginLabUser(pool,{
          email:string(d.email),password:string(d.password),
          secret:authSecret,
          ...(d.totpCode!==undefined?{totpCode:string(d.totpCode)}:{}),
          ...(totpSecret?{totpSecret}:{})
        });
        reply(res,200,result);
        return;
      }
      if(method==='GET'&&route==='/v1/users/me'){
        reply(res,200,await readAuthenticatedProfile(pool,{
          sessionToken:bearer(req),secret:authSecret
        }));
        return;
      }
      if(method==='PATCH'&&route==='/v1/users/me'){
        const d=fields(await readBody(req),[
          'displayName','expectedVersion','idempotencyKey']);
        reply(res,200,await updateAuthenticatedProfile(pool,{
          sessionToken:bearer(req),secret:authSecret,
          displayName:string(d.displayName),expectedVersion:integer(d.expectedVersion),
          idempotencyKey:string(d.idempotencyKey)
        }));
        return;
      }
      if(method==='GET'&&route==='/v1/users/role'){
        reply(res,200,await readMyIdentityRole(pool,{
          sessionToken:bearer(req),secret:authSecret
        }));
        return;
      }
      if(method==='POST'&&route==='/v1/users/mfa/start'){
        if(!totpSecret){reply(res,503,{error:'USERS_UNAVAILABLE'});return;}
        const d=fields(await readBody(req),['currentPassword']);
        reply(res,200,await beginLabTotpEnrollment(pool,{
          sessionToken:bearer(req),secret:authSecret,totpSecret,
          currentPassword:string(d.currentPassword)
        }));
        return;
      }
      if(method==='POST'&&route==='/v1/users/mfa/confirm'){
        if(!totpSecret){reply(res,503,{error:'USERS_UNAVAILABLE'});return;}
        const d=fields(await readBody(req),['code']);
        reply(res,200,await confirmLabTotpEnrollment(pool,{
          sessionToken:bearer(req),secret:authSecret,totpSecret,
          code:string(d.code)
        }));
        return;
      }
      if(method==='GET'&&route==='/v1/users/addresses'){
        reply(res,200,await listMyAddresses(pool,{
          sessionToken:bearer(req),secret:authSecret
        }));
        return;
      }
      if(method==='POST'&&route==='/v1/users/addresses'){
        const d=fields(await readBody(req),['address','idempotencyKey']);
        reply(res,201,await saveMyAddress(pool,{
          sessionToken:bearer(req),secret:authSecret,
          address:fields(d.address,['label','street','exterior','interior',
            'neighborhood','city','state','postalCode','isDefault']) as unknown as AddressInput,
          idempotencyKey:string(d.idempotencyKey)
        }));
        return;
      }
      if(method==='PATCH'&&route==='/v1/users/addresses'){
        const d=fields(await readBody(req),[
          'addressId','address','expectedVersion'
        ]);
        reply(res,200,await updateMyAddress(pool,{
          sessionToken:bearer(req),secret:authSecret,
          addressId:string(d.addressId),
          address:fields(d.address,['label','street','exterior','interior',
            'neighborhood','city','state','postalCode','isDefault']) as unknown as AddressInput,
          expectedVersion:integer(d.expectedVersion)
        }));
        return;
      }
      if(method==='POST'&&route==='/v1/users/addresses/default'){
        const d=fields(await readBody(req),['addressId']);
        reply(res,200,await setMyDefaultAddress(pool,{
          sessionToken:bearer(req),secret:authSecret,
          addressId:string(d.addressId)
        }));
        return;
      }
      if(method==='POST'&&route==='/v1/users/addresses/delete'){
        const d=fields(await readBody(req),['addressId']);
        reply(res,200,await deleteMyAddress(pool,{
          sessionToken:bearer(req),secret:authSecret,
          addressId:string(d.addressId)
        }));
        return;
      }
      if(method==='GET'&&route==='/v1/users/preferences'){
        reply(res,200,await readMyPreferences(pool,{
          sessionToken:bearer(req),secret:authSecret
        }));
        return;
      }
      if(method==='PUT'&&route==='/v1/users/preferences'){
        const d=fields(await readBody(req),['locale','marketingOptIn']);
        if(typeof d.marketingOptIn!=='boolean')
          throw new UsersError('USERS_REQUEST_INVALID');
        reply(res,200,await updateMyPreferences(pool,{
          sessionToken:bearer(req),secret:authSecret,
          locale:string(d.locale),marketingOptIn:d.marketingOptIn
        }));
        return;
      }
      if(method==='GET'&&route==='/v1/users/export'){
        reply(res,200,await exportMyData(pool,{
          sessionToken:bearer(req),secret:authSecret
        }));
        return;
      }
      if(method==='GET'&&route==='/v1/users/sessions'){
        reply(res,200,await listAuthenticatedSessions(pool,{
          sessionToken:bearer(req),secret:authSecret
        }));
        return;
      }
      if(method==='POST'&&route==='/v1/users/sessions/revoke'){
        const d=fields(await readBody(req),['sessionId']);
        reply(res,200,await revokeAuthenticatedSession(pool,{
          sessionToken:bearer(req),secret:authSecret,
          sessionId:string(d.sessionId)
        }));
        return;
      }
      if(method==='POST'&&route==='/v1/users/sessions/revoke-others'){
        fields(await readBody(req),[]);
        reply(res,200,await revokeOtherAuthenticatedSessions(pool,{
          sessionToken:bearer(req),secret:authSecret
        }));
        return;
      }
      if(method==='POST'&&route==='/v1/users/logout'){
        fields(await readBody(req),[]);
        reply(res,200,await logoutLabSession(pool,{
          sessionToken:bearer(req),secret:authSecret
        }));
        return;
      }
      if(method==='POST'&&route==='/v1/users/forgot-password'){
        const d=fields(await readBody(req),['email']);
        const email=string(d.email);
        if(!sendPasswordReset){
          reply(res,503,{error:'USERS_UNAVAILABLE'});
          return;
        }
        const proof=await issueLabPasswordRecovery(pool,{
          email,secret:emailSecret
        });
        if(proof)await sendPasswordReset(proof.email,proof.token,proof.userId);
        // Identical response for missing, unverified, locked, and valid users.
        reply(res,202,{accepted:true});
        return;
      }
      if(method==='POST'&&route==='/v1/users/reset-password'){
        const d=fields(await readBody(req),[
          'userId','token','newPassword']);
        const done=await resetLabPassword(pool,{
          userId:string(d.userId),token:string(d.token),
          newPassword:string(d.newPassword),
          authSecret,emailSecret
        });
        reply(res,200,done);
        return;
      }
      if(method==='POST'&&route==='/v1/users/change-password'){
        const d=fields(await readBody(req),['currentPassword','newPassword']);
        reply(res,200,await changeAuthenticatedPassword(pool,{
          sessionToken:bearer(req),secret:authSecret,
          currentPassword:string(d.currentPassword),
          newPassword:string(d.newPassword)
        }));
        return;
      }
      if(method==='POST'&&route==='/v1/users/request-deletion'){
        const d=fields(await readBody(req),['expectedVersion','idempotencyKey']);
        reply(res,200,await requestAuthenticatedDeletion(pool,{
          sessionToken:bearer(req),secret:authSecret,
          expectedVersion:integer(d.expectedVersion),
          idempotencyKey:string(d.idempotencyKey)
        }));
        return;
      }
      reply(res,404,{error:'USERS_ROUTE_NOT_FOUND'});
    }catch(error){
      if(error instanceof UsersError){
        const status=errorStatus(error);
        reply(res,status,{error:status===503?'USERS_UNAVAILABLE':error.code});
        return;
      }
      // No PII, credential, token, query, stack or raw error exposed.
      reply(res,500,{error:'USERS_INTERNAL_ERROR'});
    }
  });
}
