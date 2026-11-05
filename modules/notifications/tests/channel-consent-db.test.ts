import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {publishNotification,readInbox,markNotificationRead} from '../src/store.js';
import {setRecipientPreference,registerDevice} from '../src/recipients.js';
import {NotificationError} from '../src/domain.js';

const url=process.env.NOTIFICATIONS_CI_URL??'';
const enabled=/\/tala_notifications_v2_test(?:$|\?)/.test(url);
const db=()=>new pg.Pool({connectionString:url,max:14});
const id=()=>randomUUID();
const set=async(pool:pg.Pool,recipientId:string,
  channel:'in_app'|'email'|'push',category:'marketing'|'transactional',
  enabled:boolean)=>setRecipientPreference(pool,{
    recipientId,app:'customer',channel,category,enabled
  });
test('M5 LAB2: email-only marketing opt-in does not force in-app visibility',
  {skip:!enabled,timeout:60000},async()=>{
  const pool=db();
  try{
    const recipientId=id();
    await set(pool,recipientId,'email','marketing',true);
    const posted=await publishNotification(pool,{
      recipientId,sourceEventId:id(),app:'customer',eventType:'marketing.promotion'
    });
    assert.equal(posted.suppressed,false);
    assert.equal(posted.deliveriesQueued,1);
    const center=await readInbox(pool,{recipientId,app:'customer'});
    assert.deepEqual(center.items,[]);
    assert.equal(center.unreadCount,0);
    assert.equal((await markNotificationRead(pool,{recipientId,app:'customer',
      notificationId:posted.notification!.id})).found,false);
    const r=await pool.query(
      'SELECT channel FROM tala_notifications_v2.deliveries WHERE notification_id=$1',
      [posted.notification!.id]);
    assert.deepEqual(r.rows.map(x=>x.channel),['email']);
    assert.equal((await pool.query(
      'SELECT visible_in_app FROM tala_notifications_v2.inbox WHERE id=$1',
      [posted.notification!.id])).rows[0]?.visible_in_app,false);
    await assert.rejects(()=>readInbox(pool,{recipientId,app:'customer',
      beforeId:posted.notification!.id}),
      (e:unknown)=>e instanceof NotificationError&&
        e.code==='NOTIFICATIONS_CURSOR_INVALID');
  }finally{await pool.end();}
});

test('M5 LAB2: push-only consent delivers without email or in-app',
  {skip:!enabled,timeout:60000},async()=>{
  const pool=db();
  try{
    const recipientId=id();
    await set(pool,recipientId,'in_app','transactional',false);
    await set(pool,recipientId,'email','transactional',false);
    await registerDevice(pool,{recipientId,app:'customer',
      platform:'android',token:'fcm-token-'+id()+'-abcdefghijklmnopqrstuvwxyz',
      secret:Buffer.alloc(32,73)});
    const posted=await publishNotification(pool,{
      recipientId,sourceEventId:id(),app:'customer',eventType:'order.confirmed'
    });
    assert.equal(posted.deliveriesQueued,1);
    assert.equal((await readInbox(pool,{recipientId,app:'customer'})).items.length,0);
    const out=await pool.query(
      'SELECT channel FROM tala_notifications_v2.deliveries WHERE notification_id=$1',
      [posted.notification!.id]);
    assert.deepEqual(out.rows.map(x=>x.channel),['push']);
  }finally{await pool.end();}
});

test('M5 LAB2: suppressed marketing event cannot reappear after opt-in, even under concurrency',
  {skip:!enabled,timeout:60000},async()=>{
  const pool=db();
  try{
    const recipientId=id(),sourceEventId=id();
    const input={recipientId,sourceEventId,app:'customer' as const,
      eventType:'marketing.promotion' as const};
    const burst=await Promise.all(Array.from({length:14},()=>
      publishNotification(pool,input)));
    assert.equal(burst.filter(x=>x.replayed).length,13);
    assert.ok(burst.every(x=>x.suppressed&&x.notification===null));
    await set(pool,recipientId,'in_app','marketing',true);
    await set(pool,recipientId,'email','marketing',true);
    const replay=await publishNotification(pool,input);
    assert.deepEqual({
      replayed:replay.replayed,suppressed:replay.suppressed,
      notification:replay.notification,queued:replay.deliveriesQueued
    },{replayed:true,suppressed:true,notification:null,queued:0});
    assert.equal((await readInbox(pool,{recipientId,app:'customer'})).items.length,0);
    const newEvent=await publishNotification(pool,{...input,sourceEventId:id()});
    assert.equal(newEvent.suppressed,false);
    assert.equal(newEvent.deliveriesQueued,1);
    const receipt=await pool.query(
      'SELECT suppressed,notification_id FROM tala_notifications_v2.publication_receipts '+
      'WHERE recipient_id=$1 AND source_event_id=$2',
      [recipientId,sourceEventId]);
    assert.deepEqual(receipt.rows,[{suppressed:true,notification_id:null}]);
  }finally{await pool.end();}
});
