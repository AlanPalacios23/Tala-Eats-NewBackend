/** M5 internal publication and in-app inbox; no live push/email at publication.
 * Caller MUST be a trusted event producer or authenticated identity adapter.
 */
import type {Pool} from 'pg';
import {NotificationError,render,uuid,appValue,type App,type PublishInput} from './domain.js';
import {transaction} from './db.js';
import {isEnabled} from './recipients.js';

type InboxRow={id:string,source_event_id:string,recipient_id:string,app:App,
 event_type:string,category:string,title:string,body:string,deep_link:string,
 data:{resourceId?:string},created_at:Date,read_at:Date|null,dismissed_at:Date|null,
 content_fingerprint:string};
const publicItem=(r:InboxRow)=>Object.freeze({
  id:r.id,eventType:r.event_type,category:r.category,title:r.title,body:r.body,
  deepLink:r.deep_link,data:r.data,createdAt:r.created_at.toISOString(),
  readAt:r.read_at?.toISOString()??null
});
export async function publishNotification(pool:Pool,input:PublishInput){
  const n=render(input);
  return transaction(pool,async c=>{
    // A suppressed message still consumes its source event ID. A later
    // preference change must NOT replay yesterday's promotion.
    // Unique insert also serializes concurrent publishers across processes.
    const owner=await c.query<{source_event_id:string}>(`
      INSERT INTO tala_notifications_v2.publication_receipts
        (recipient_id,source_event_id,app,content_fingerprint,suppressed)
      VALUES($1::uuid,$2::uuid,$3,$4,true)
      ON CONFLICT(recipient_id,source_event_id) DO NOTHING
      RETURNING source_event_id`,
      [n.recipientId,n.sourceEventId,n.app,n.contentFingerprint]);
    if(!owner.rowCount){
      const existing=await c.query<{app:App,content_fingerprint:string,
        suppressed:boolean,notification_id:string|null}>(`
        SELECT app,content_fingerprint,suppressed,notification_id
        FROM tala_notifications_v2.publication_receipts
        WHERE recipient_id=$1::uuid AND source_event_id=$2::uuid`,
        [n.recipientId,n.sourceEventId]);
      const decision=existing.rows[0];
      if(!decision||decision.app!==n.app||
         decision.content_fingerprint!==n.contentFingerprint)
        throw new NotificationError('NOTIFICATIONS_IDEMPOTENCY_CONFLICT');
      if(decision.suppressed)return Object.freeze({notification:null,
        replayed:true,suppressed:true,deliveriesQueued:0});
      const row=await c.query<InboxRow>(`
        SELECT * FROM tala_notifications_v2.inbox
        WHERE id=$1::uuid AND recipient_id=$2::uuid`,
        [decision.notification_id,n.recipientId]);
      if(!row.rows[0])throw new NotificationError('NOTIFICATIONS_RECEIPT_INVALID');
      return Object.freeze({notification:publicItem(row.rows[0]),
        replayed:true,suppressed:false,deliveriesQueued:0});
    }
    // Consent is checked INDEPENDENTLY for each channel. An opted-in email
    // must work even when the in-app inbox itself is disabled.
    const inApp=await isEnabled(c,{recipientId:n.recipientId,app:n.app,
      channel:'in_app',category:n.category});
    const viaEmail=n.channelEmail&&await isEnabled(c,{
      recipientId:n.recipientId,app:n.app,channel:'email',category:n.category});
    const viaPush=n.channelPush&&await isEnabled(c,{
      recipientId:n.recipientId,app:n.app,channel:'push',category:n.category});
    if(!inApp&&!viaEmail&&!viaPush)
      return Object.freeze({notification:null,replayed:false,
        suppressed:true,deliveriesQueued:0});
    // Inbox record also owns the durable delivery jobs, but only visible
    // records are returned to the consumer's notification center.
    const created=await c.query<InboxRow>(`
      INSERT INTO tala_notifications_v2.inbox
        (source_event_id,recipient_id,app,category,event_type,
         content_fingerprint,title,body,deep_link,data,visible_in_app)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
      RETURNING *`,
      [n.sourceEventId,n.recipientId,n.app,n.category,n.eventType,
        n.contentFingerprint,n.title,n.body,n.deepLink,JSON.stringify(n.data),
        inApp]);
    const row=created.rows[0]!;
    await c.query(`
      UPDATE tala_notifications_v2.publication_receipts SET
        suppressed=false,notification_id=$3::uuid
      WHERE recipient_id=$1::uuid AND source_event_id=$2::uuid`,
      [n.recipientId,n.sourceEventId,row.id]);
    let queued=0;
    if(viaEmail){
      const result=await c.query(`
        INSERT INTO tala_notifications_v2.deliveries(notification_id,channel)
        VALUES($1::uuid,'email')`,[row.id]);
      queued+=result.rowCount??0;
    }
    if(viaPush){
      const devices=await c.query<{id:string}>(`
        SELECT id FROM tala_notifications_v2.devices WHERE
        recipient_id=$1::uuid AND app=$2 AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 30`,[n.recipientId,n.app]);
      for(const device of devices.rows){
        await c.query(`
          INSERT INTO tala_notifications_v2.deliveries
            (notification_id,channel,device_id)
          VALUES($1::uuid,'push',$2::uuid)`,[row.id,device.id]);
        queued++;
      }
    }
    // Realtime hint is emitted only on COMMIT. Applications must still fetch
    // the durable inbox; LISTEN/NOTIFY is never the source of truth.
    if(inApp)await c.query(`
      SELECT pg_notify('tala_notifications_v2_new_inbox',$1)`,
      [JSON.stringify({notificationId:row.id,
        recipientId:n.recipientId,app:n.app})]);
    return Object.freeze({notification:publicItem(row),replayed:false,
      suppressed:false,deliveriesQueued:queued});
  });
}
export async function readInbox(pool:Pool,{
  recipientId,app,limit=20,beforeId
}:{recipientId:string,app:App,limit?:number,beforeId?:string}){
  const id=uuid(recipientId),scope=appValue(app);
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)
    throw new NotificationError('NOTIFICATIONS_PAGE_INVALID');
  const cursor=beforeId===undefined?null:uuid(beforeId);
  return transaction(pool,async c=>{
    if(cursor){
      const row=await c.query<{id:string}>(`
        SELECT id FROM tala_notifications_v2.inbox
        WHERE id=$1::uuid AND recipient_id=$2::uuid AND app=$3`,
        [cursor,id,scope]);
      if(!row.rows[0])throw new NotificationError('NOTIFICATIONS_CURSOR_INVALID');
    }
    // Cursor comparison stays inside PostgreSQL; JS Date loses microseconds.
    const r=await c.query<InboxRow>(`
      SELECT * FROM tala_notifications_v2.inbox
      WHERE recipient_id=$1::uuid AND app=$2 AND dismissed_at IS NULL
        AND visible_in_app AND ($3::uuid IS NULL OR
          (created_at,id)<(
            SELECT created_at,id FROM tala_notifications_v2.inbox
            WHERE id=$3::uuid AND recipient_id=$1::uuid AND app=$2))
      ORDER BY created_at DESC,id DESC LIMIT $4`,
      [id,scope,cursor,limit+1]);
    const rows=r.rows.slice(0,limit);
    const unread=await c.query<{n:number}>(`
      SELECT count(*)::int AS n FROM tala_notifications_v2.inbox
      WHERE recipient_id=$1::uuid AND app=$2 AND dismissed_at IS NULL
        AND visible_in_app AND read_at IS NULL`,[id,scope]);
    return Object.freeze({items:Object.freeze(rows.map(publicItem)),
      unreadCount:unread.rows[0]?.n??0,
      nextCursor:r.rows.length>limit?rows[rows.length-1]!.id:null});
  },true);
}
export async function markNotificationRead(pool:Pool,{
  recipientId,app,notificationId
}:{recipientId:string,app:App,notificationId:string}){
  const id=uuid(recipientId),scope=appValue(app),target=uuid(notificationId);
  return transaction(pool,async c=>{
    const r=await c.query(`
      UPDATE tala_notifications_v2.inbox SET
        read_at=COALESCE(read_at,clock_timestamp())
      WHERE id=$1::uuid AND recipient_id=$2::uuid AND app=$3
        AND dismissed_at IS NULL AND visible_in_app`,[target,id,scope]);
    return Object.freeze({found:r.rowCount===1});
  });
}
export async function markAllNotificationsRead(pool:Pool,{
  recipientId,app
}:{recipientId:string,app:App}){
  const id=uuid(recipientId),scope=appValue(app);
  return transaction(pool,async c=>{
    const r=await c.query(`
      UPDATE tala_notifications_v2.inbox SET read_at=clock_timestamp()
      WHERE recipient_id=$1::uuid AND app=$2
        AND read_at IS NULL AND dismissed_at IS NULL
        AND visible_in_app`,[id,scope]);
    return Object.freeze({readCount:r.rowCount??0});
  });
}
export async function dismissNotification(pool:Pool,{
  recipientId,app,notificationId
}:{recipientId:string,app:App,notificationId:string}){
  const id=uuid(recipientId),scope=appValue(app),target=uuid(notificationId);
  return transaction(pool,async c=>{
    const r=await c.query(`
      UPDATE tala_notifications_v2.inbox SET
        dismissed_at=COALESCE(dismissed_at,clock_timestamp())
      WHERE id=$1::uuid AND recipient_id=$2::uuid AND app=$3
        AND visible_in_app`,
      [target,id,scope]);
    return Object.freeze({found:r.rowCount===1});
  });
}
