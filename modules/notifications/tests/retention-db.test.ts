import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {registerDevice,revokeRecipientDevice} from '../src/recipients.js';
import {publishNotification,readInbox} from '../src/store.js';
import {redactExpiredNotificationData} from '../src/retention.js';
import {NotificationError} from '../src/domain.js';

const url=process.env.NOTIFICATIONS_CI_URL??'';
const enabled=/\/tala_notifications_v2_test(?:$|\?)/.test(url);
const pool=()=>new pg.Pool({connectionString:url,max:8});
const id=()=>randomUUID();
const secret=randomBytes(32);
test('M5 retention: redacts revoked FCM secret, retains immutable attempt audit',
 {skip:!enabled,timeout:60000},async()=>{
  const db=pool();
  try{
    const recipientId=id(),token='fcm-token-'+id()+'-abcdefg';
    const device=await registerDevice(db,{
      recipientId,app:'customer',platform:'android',token,secret});
    await revokeRecipientDevice(db,{
      recipientId,app:'customer',deviceId:device.id});
    await db.query(
      "UPDATE tala_notifications_v2.devices SET "+
      "revoked_at=clock_timestamp()-interval '40 days' WHERE id=$1",
      [device.id]);
    const original=await db.query(
      'SELECT token_digest,token_cipher FROM tala_notifications_v2.devices WHERE id=$1',
      [device.id]);
    const before=await db.query(
      'SELECT count(*)::int AS n FROM tala_notifications_v2.delivery_attempts');
    const cleaned=await redactExpiredNotificationData(db,{limit:20});
    assert.ok(cleaned.revokedDeviceSecretsRedacted>=1);
    assert.equal(cleaned.auditAttemptsDeleted,0);
    const after=await db.query(
      'SELECT token_digest,token_cipher,token_redacted_at,revoked_at '+
      'FROM tala_notifications_v2.devices WHERE id=$1',[device.id]);
    assert.ok(after.rows[0]?.token_redacted_at instanceof Date);
    assert.ok(after.rows[0]?.revoked_at instanceof Date);
    assert.notEqual(after.rows[0].token_digest,original.rows[0].token_digest);
    assert.notEqual(after.rows[0].token_cipher,original.rows[0].token_cipher);
    assert.ok(!JSON.stringify(after.rows).includes(token));
    const again=await registerDevice(db,{
      recipientId,app:'customer',platform:'android',token,secret});
    assert.notEqual(again.id,device.id,
      'Redacted historical registration cannot capture the refreshed token');
    assert.equal((await db.query(
      'SELECT count(*)::int AS n FROM tala_notifications_v2.delivery_attempts'
    )).rows[0].n,before.rows[0].n);
    assert.equal((await redactExpiredNotificationData(db,{limit:20}))
      .revokedDeviceSecretsRedacted,0);
  }finally{await db.end();}
});
test('M5 retention: old delivered or in-app-only content hidden; pending jobs preserved',
 {skip:!enabled,timeout:60000},async()=>{
  const db=pool();
  try{
    const recipientId=id();
    const archival=await publishNotification(db,{
      recipientId,sourceEventId:id(),app:'customer',eventType:'order.ready'});
    const pending=await publishNotification(db,{
      recipientId,sourceEventId:id(),app:'customer',eventType:'order.confirmed'});
    assert.equal(archival.deliveriesQueued,0);
    assert.equal(pending.deliveriesQueued,1);
    await db.query(
      "UPDATE tala_notifications_v2.inbox SET "+
      "created_at=clock_timestamp()-interval '200 days' WHERE id=ANY($1::uuid[])",
      [[archival.notification!.id,pending.notification!.id]]);
    const sweep=await redactExpiredNotificationData(db,{limit:50});
    assert.ok(sweep.oldNotificationContentsRedacted>=1);
    const gone=await db.query(
      'SELECT visible_in_app,title,body,deep_link,data,content_redacted_at '+
      'FROM tala_notifications_v2.inbox WHERE id=$1',[archival.notification!.id]);
    assert.equal(gone.rows[0]?.visible_in_app,false);
    assert.equal(gone.rows[0]?.title,'Aviso archivado');
    assert.equal(gone.rows[0]?.deep_link,'/notificaciones');
    assert.deepEqual(gone.rows[0]?.data,{});
    assert.ok(gone.rows[0]?.content_redacted_at instanceof Date);
    const kept=await db.query(
      'SELECT visible_in_app,content_redacted_at FROM tala_notifications_v2.inbox '+
      'WHERE id=$1',[pending.notification!.id]);
    assert.equal(kept.rows[0]?.visible_in_app,true);
    assert.equal(kept.rows[0]?.content_redacted_at,null);
    const own=await readInbox(db,{recipientId,app:'customer'});
    assert.ok(own.items.some(x=>x.id===pending.notification!.id));
    assert.ok(!own.items.some(x=>x.id===archival.notification!.id));
    await assert.rejects(
      ()=>redactExpiredNotificationData(db,{limit:0}),
      (e:unknown)=>e instanceof NotificationError&&
        e.code==='NOTIFICATIONS_RETENTION_LIMIT_INVALID');
  }finally{await db.end();}
});
