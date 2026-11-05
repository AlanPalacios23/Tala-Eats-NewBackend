/** M5 durable outbox worker. At-least-once, claim leases and audited attempts.
 * No direct dependency on identity, orders, payment or other modules.
 * Caller supplies verified-email resolution and transport implementations.
 */
import type {Pool} from 'pg';
import {NotificationError,uuid,type App,type Category} from './domain.js';
import {transaction} from './db.js';
import {isEnabled} from './recipients.js';
import {unsealDeviceToken,requireSecret,type Platform} from './crypto.js';
export type Message={
  notificationId:string,eventType:string,title:string,body:string,
  deepLink:string,data:{resourceId?:string},recipientId:string,app:App,
  category:Category,idempotencyKey:string
};
export type EmailMessage=Message&{to:string};
export type PushMessage=Message&{token:string,platform:Platform};
export type DeliveryDependencies={
  secret:Buffer,
  resolveVerifiedEmail:(recipientId:string,app:App)=>Promise<string|null>,
  sendEmail:(message:EmailMessage)=>Promise<void>,
  sendPush:(message:PushMessage)=>Promise<void>
};
export class DeliveryFailure extends Error{
  constructor(readonly code:string,readonly permanent:boolean,
    readonly retryAfterSeconds?:number){
    super(code);this.name='DeliveryFailure';
    if(!/^[A-Z0-9_]{2,60}$/.test(code)||
       (retryAfterSeconds!==undefined&&
        (!Number.isSafeInteger(retryAfterSeconds)||retryAfterSeconds<0||
         retryAfterSeconds>3600)))
      throw new NotificationError('NOTIFICATIONS_DELIVERY_ERROR_INVALID');
  }
}
type Claim={id:string,notification_id:string,channel:'email'|'push',
 device_id:string|null,attempts:number,retry_cycle:number,lease_token:string};
type WorkRow={id:string,recipient_id:string,app:App,category:Category,
 event_type:string,title:string,body:string,deep_link:string,
 data:{resourceId?:string},device_id:string|null,platform:Platform|null,
 token_iv:string|null,token_cipher:string|null,token_tag:string|null,
 revoked_at:Date|null};
const MAX_ATTEMPTS=5;
const BACKOFF_SECONDS=[30,120,300,900,1800];
export async function claimDueDeliveries(pool:Pool,{limit=10}:{limit?:number}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)
    throw new NotificationError('NOTIFICATIONS_CLAIM_LIMIT_INVALID');
  return transaction(pool,async c=>{
    // Keep expired-lease recovery bounded. A crash is itself an audited
    // attempt; otherwise attempts=2 can exist without an attempt=1 record.
    // We lock only 100 expired jobs at a time to avoid holding a table-wide
    // lock or timing out when a worker fleet has been offline.
    const expired=await c.query<{
      id:string,attempts:number,retry_cycle:number
    }>(`
      SELECT id,attempts,retry_cycle
      FROM tala_notifications_v2.deliveries
      WHERE status='leased' AND lease_until<=clock_timestamp()
      ORDER BY lease_until,id
      FOR UPDATE SKIP LOCKED LIMIT 100`);
    const expiredIds=expired.rows.map(x=>x.id);
    if(expiredIds.length){
      await c.query(`
        INSERT INTO tala_notifications_v2.delivery_attempts
          (delivery_id,retry_cycle,attempt_number,result,error_code)
        SELECT id,retry_cycle,attempts,
          CASE WHEN attempts>=$2 THEN 'dead_letter' ELSE 'retry' END,
          CASE WHEN attempts>=$2 THEN 'LEASE_EXHAUSTED' ELSE 'LEASE_EXPIRED' END
        FROM tala_notifications_v2.deliveries
        WHERE id=ANY($1::uuid[])
        ON CONFLICT(delivery_id,retry_cycle,attempt_number) DO NOTHING`,
        [expiredIds,MAX_ATTEMPTS]);
      await c.query(`
        UPDATE tala_notifications_v2.deliveries
        SET status='dead_letter',lease_token=NULL,lease_until=NULL,
          last_error_code='LEASE_EXHAUSTED',updated_at=clock_timestamp()
        WHERE id=ANY($1::uuid[]) AND attempts>=$2`,
        [expiredIds,MAX_ATTEMPTS]);
    }
    const result=await c.query<Claim>(`
      WITH due AS (
        SELECT id FROM tala_notifications_v2.deliveries
        WHERE attempts<$1 AND (
          (status IN ('queued','retry') AND next_attempt_at<=clock_timestamp())
          OR (status='leased' AND lease_until<=clock_timestamp()
              AND id=ANY($3::uuid[])))
        ORDER BY priority DESC,next_attempt_at,updated_at,id
        FOR UPDATE SKIP LOCKED LIMIT $2
      )
      UPDATE tala_notifications_v2.deliveries d
      SET status='leased',attempts=d.attempts+1,
        lease_token=gen_random_uuid(),
        lease_until=clock_timestamp()+interval '60 seconds',
        updated_at=clock_timestamp()
      FROM due WHERE d.id=due.id
      RETURNING d.id,d.notification_id,d.channel,d.device_id,
        d.attempts,d.retry_cycle,d.lease_token`,
        [MAX_ATTEMPTS,limit,expiredIds]);
    return result.rows.map(x=>Object.freeze(x));
  });
}
async function settleDelivery(pool:Pool,claim:Claim,{
  result,errorCode,retryAfterSeconds=0
}:{result:'delivered'|'retry'|'dead_letter'|'suppressed',
  errorCode?:string,retryAfterSeconds?:number}){
  if(errorCode&&!/^[A-Z0-9_]{2,60}$/.test(errorCode))
    throw new NotificationError('NOTIFICATIONS_DELIVERY_ERROR_INVALID');
  const error=errorCode??null;
  // Respect Retry-After from FCM/Resend, bounded to an hour, but never
  // shorten the normal exponential retry interval.
  const next=Math.max(BACKOFF_SECONDS[Math.min(claim.attempts-1,
    BACKOFF_SECONDS.length-1)]!,retryAfterSeconds);
  const status=result==='retry'&&claim.attempts>=MAX_ATTEMPTS
    ?'dead_letter':result;
  return transaction(pool,async c=>{
    const row=await c.query(`
      UPDATE tala_notifications_v2.deliveries SET
        status=$3,lease_token=NULL,lease_until=NULL,
        next_attempt_at=CASE WHEN $3='retry'
          THEN clock_timestamp()+($4::int*interval '1 second')
          ELSE next_attempt_at END,
        delivered_at=CASE WHEN $3='delivered' THEN clock_timestamp()
          ELSE delivered_at END,
        last_error_code=$5,updated_at=clock_timestamp()
      WHERE id=$1::uuid AND lease_token=$2::uuid AND status='leased'
      RETURNING id`,
      [claim.id,claim.lease_token,status,next,error]);
    if(!row.rowCount)return Object.freeze({settled:false,status:'lease_lost'});
    await c.query(`
      INSERT INTO tala_notifications_v2.delivery_attempts
        (delivery_id,retry_cycle,attempt_number,result,error_code)
      VALUES($1::uuid,$2,$3,$4,$5)`,
      [claim.id,claim.retry_cycle,claim.attempts,status,error]);
    return Object.freeze({settled:true,status});
  });
}
async function resolveWork(pool:Pool,claim:Claim){
  return transaction(pool,async c=>{
    const rows=await c.query<WorkRow>(`
      SELECT i.id,i.recipient_id,i.app,i.category,i.event_type,
        i.title,i.body,i.deep_link,i.data,
        d.device_id,dev.platform,dev.token_iv,dev.token_cipher,
        dev.token_tag,dev.revoked_at
      FROM tala_notifications_v2.deliveries d
      JOIN tala_notifications_v2.inbox i ON i.id=d.notification_id
      LEFT JOIN tala_notifications_v2.devices dev ON dev.id=d.device_id
      WHERE d.id=$1::uuid AND d.status='leased'
        AND d.lease_token=$2::uuid`,
      [claim.id,claim.lease_token]);
    const row=rows.rows[0];
    if(!row)return null;
    const enabled=await isEnabled(c,{recipientId:row.recipient_id,app:row.app,
      category:row.category,channel:claim.channel});
    return {row,enabled};
  },true);
}
export async function processDeliveryBatch(pool:Pool,deps:DeliveryDependencies,
 {limit=10}:{limit?:number}={}){
  const secret=requireSecret(deps.secret);
  if(typeof deps.resolveVerifiedEmail!=='function'||
     typeof deps.sendEmail!=='function'||typeof deps.sendPush!=='function')
    throw new NotificationError('NOTIFICATIONS_TRANSPORT_INVALID');
  const claims=await claimDueDeliveries(pool,{limit});
  const stats={claimed:claims.length,delivered:0,retried:0,
    deadLetter:0,suppressed:0,leaseLost:0};
  for(const claim of claims){
    try{
      const info=await resolveWork(pool,claim);
      if(!info){
        stats.leaseLost++;
        continue;
      }
      const {row,enabled}=info;
      if(!enabled || (claim.channel==='push' &&
          (!row.device_id||!row.platform||!row.token_iv||
           !row.token_cipher||!row.token_tag||row.revoked_at))){
        const settled=await settleDelivery(pool,claim,{
          result:'suppressed',errorCode:'CHANNEL_DISABLED'});
        if(settled.settled)stats.suppressed++;else stats.leaseLost++;
        continue;
      }
      const message:Message={
        notificationId:row.id,eventType:row.event_type,
        title:row.title,body:row.body,deepLink:row.deep_link,
        data:row.data,recipientId:row.recipient_id,app:row.app,
        category:row.category,idempotencyKey:claim.id
      };
      if(claim.channel==='email'){
        const to=await deps.resolveVerifiedEmail(row.recipient_id,row.app);
        if(!to){
          const done=await settleDelivery(pool,claim,{
            result:'suppressed',errorCode:'NO_VERIFIED_EMAIL'});
          if(done.settled)stats.suppressed++;else stats.leaseLost++;
          continue;
        }
        await deps.sendEmail({...message,to});
      }else{
        const token=unsealDeviceToken({
          recipient_id:row.recipient_id,app:row.app,
          platform:row.platform!,token_iv:row.token_iv!,
          token_cipher:row.token_cipher!,token_tag:row.token_tag!
        },secret);
        await deps.sendPush({...message,platform:row.platform!,token});
      }
      const done=await settleDelivery(pool,claim,{result:'delivered'});
      if(done.settled)stats.delivered++;else stats.leaseLost++;
    }catch(error){
      const code=error instanceof DeliveryFailure?error.code:'PROVIDER_TEMPORARY';
      // Revoke only when FCM explicitly confirms UNREGISTERED. Generic 400,
      // 404, timeouts and misconfigured Firebase projects are NOT evidence
      // of an invalid device registration.
      if(code==='FCM_UNREGISTERED'&&claim.channel==='push'&&claim.device_id){
        await transaction(pool,async c=>{
          await c.query(
            'UPDATE tala_notifications_v2.devices d SET revoked_at=clock_timestamp() '+
            'WHERE d.id=$1::uuid AND d.revoked_at IS NULL AND EXISTS ('+
              'SELECT 1 FROM tala_notifications_v2.deliveries job '+
              'JOIN tala_notifications_v2.inbox i ON i.id=job.notification_id '+
              'WHERE job.id=$2::uuid AND job.device_id=d.id '+
              'AND i.recipient_id=d.recipient_id AND i.app=d.app)',
            [claim.device_id,claim.id]);
        });
      }
      const disposition=error instanceof DeliveryFailure&&error.permanent
        ?'dead_letter':'retry';
      const done=await settleDelivery(pool,claim,{
        result:disposition,errorCode:code,
        ...(error instanceof DeliveryFailure&&
          error.retryAfterSeconds!==undefined
          ?{retryAfterSeconds:error.retryAfterSeconds}:{})
      });
      if(!done.settled)stats.leaseLost++;
      else if(done.status==='retry')stats.retried++;
      else stats.deadLetter++;
    }
  }
  return Object.freeze(stats);
}
/** Manual operator-only recovery; never expose directly to untrusted apps. */
export async function requeueDeadLetter(pool:Pool,{deliveryId}:{deliveryId:string}){
  const id=uuid(deliveryId);
  return transaction(pool,async c=>{
    const r=await c.query(`
      UPDATE tala_notifications_v2.deliveries SET status='queued',
        attempts=0,retry_cycle=retry_cycle+1,next_attempt_at=clock_timestamp(),
        last_error_code=NULL,updated_at=clock_timestamp()
      WHERE id=$1::uuid AND status='dead_letter'`,[id]);
    return Object.freeze({requeued:r.rowCount===1});
  });
}
