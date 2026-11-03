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
    // Serialize same recipient's decisions and guard the UNIQUE event envelope.
    // All event content is created by M5's allowlisted template catalog.
    const existing=await c.query<InboxRow>(`
      SELECT * FROM tala_notifications_v2.inbox
      WHERE recipient_id=$1::uuid AND source_event_id=$2::uuid FOR UPDATE`,
      [n.recipientId,n.sourceEventId]);
    if(existing.rows[0]){
      if(existing.rows[0].content_fingerprint!==n.contentFingerprint||
         existing.rows[0].app!==n.app)
        throw new NotificationError('NOTIFICATIONS_IDEMPOTENCY_CONFLICT');
      return Object.freeze({notification:publicItem(existing.rows[0]),
        replayed:true,suppressed:false,deliveriesQueued:0});
    }
    if(!await isEnabled(c,{recipientId:n.recipientId,app:n.app,
      channel:'in_app',category:n.category})){
      return Object.freeze({notification:null,replayed:false,
        suppressed:true,deliveriesQueued:0});
    }
    const created=await c.query<InboxRow>(`
      INSERT INTO tala_notifications_v2.inbox
        (source_event_id,recipient_id,app,category,event_type,
         content_fingerprint,title,body,deep_link,data)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
      ON CONFLICT(recipient_id,source_event_id) DO NOTHING
      RETURNING *`,
      [n.sourceEventId,n.recipientId,n.app,n.category,n.eventType,
        n.contentFingerprint,n.title,n.body,n.deepLink,JSON.stringify(n.data)]);
    let row=created.rows[0];
    if(!row){
      // A concurrent commit won the UNIQUE key while our INSERT waited.
      const winner=await c.query<InboxRow>(`
        SELECT * FROM tala_notifications_v2.inbox
        WHERE recipient_id=$1::uuid AND source_event_id=$2::uuid`,
        [n.recipientId,n.sourceEventId]);
      row=winner.rows[0];
      if(!row||row.content_fingerprint!==n.contentFingerprint||row.app!==n.app)
        throw new NotificationError('NOTIFICATIONS_IDEMPOTENCY_CONFLICT');
      return Object.freeze({notification:publicItem(row),replayed:true,
        suppressed:false,deliveriesQueued:0});
    }
    let queued=0;
    if(n.channelEmail&&await isEnabled(c,{
      recipientId:n.recipientId,app:n.app,channel:'email',category:n.category})){
      const result=await c.query(`
        INSERT INTO tala_notifications_v2.deliveries(notification_id,channel)
        VALUES($1::uuid,'email')`,[row.id]);
      queued+=result.rowCount??0;
    }
    if(n.channelPush&&await isEnabled(c,{
      recipientId:n.recipientId,app:n.app,channel:'push',category:n.category})){
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
    let before:Date|null=null,beginId:string|null=null;
    if(cursor){
      const row=await c.query<{id:string,created_at:Date}>(`
        SELECT id,created_at FROM tala_notifications_v2.inbox
        WHERE id=$1::uuid AND recipient_id=$2::uuid AND app=$3`,
        [cursor,id,scope]);
      if(!row.rows[0])throw new NotificationError('NOTIFICATIONS_CURSOR_INVALID');
      beginId=row.rows[0].id;before=row.rows[0].created_at;
    }
    const r=await c.query<InboxRow>(`
      SELECT * FROM tala_notifications_v2.inbox
      WHERE recipient_id=$1::uuid AND app=$2 AND dismissed_at IS NULL
        AND ($3::timestamptz IS NULL OR
          (created_at,id)<($3::timestamptz,$4::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $5`,
      [id,scope,before,beginId,limit+1]);
    const rows=r.rows.slice(0,limit);
    const unread=await c.query<{n:number}>(`
      SELECT count(*)::int AS n FROM tala_notifications_v2.inbox
      WHERE recipient_id=$1::uuid AND app=$2 AND dismissed_at IS NULL
        AND read_at IS NULL`,[id,scope]);
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
        AND dismissed_at IS NULL`,[target,id,scope]);
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
        AND read_at IS NULL AND dismissed_at IS NULL`,[id,scope]);
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
      WHERE id=$1::uuid AND recipient_id=$2::uuid AND app=$3`,
      [target,id,scope]);
    return Object.freeze({found:r.rowCount===1});
  });
}
