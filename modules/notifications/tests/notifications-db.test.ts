import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {NotificationError} from '../src/domain.js';
import {registerDevice,listRecipientDevices,revokeRecipientDevice,
  readRecipientPreferences,setRecipientPreference} from '../src/recipients.js';
import {publishNotification,readInbox,markNotificationRead,
  markAllNotificationsRead,dismissNotification} from '../src/store.js';

const url=process.env.NOTIFICATIONS_CI_URL??'';
const enabled=/\/tala_notifications_v2_test(?:$|\?)/.test(url);
const db=()=>new pg.Pool({connectionString:url,max:20});
const secret=randomBytes(32),key=()=>randomUUID();
const token=()=> 'fcm-token-'+randomUUID()+'-abcdefghijklmnopqrstuvwxyz';
const fail=(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,
  (e:unknown)=>e instanceof NotificationError&&e.code===code);

test('M5 devices encrypted, owner-locked, reactivation idempotent and revocation', 
 {skip:!enabled,timeout:60000},async()=>{
  const pool=db();
  try{
    const recipientId=key(),args={recipientId,app:'courier' as const,
      platform:'android' as const,token:token(),secret};
    const created=await registerDevice(pool,args);
    assert.equal((await registerDevice(pool,args)).id,created.id);
    const dbToken=await pool.query(
      'SELECT token_digest,token_cipher FROM tala_notifications_v2.devices WHERE id=$1',[created.id]);
    assert.equal(JSON.stringify(dbToken.rows).includes(args.token),false);
    await fail(()=>registerDevice(pool,{...args,recipientId:key()}),
      'NOTIFICATIONS_DEVICE_OWNERSHIP_CONFLICT');
    assert.equal((await listRecipientDevices(pool,{
      recipientId,app:'courier'})).devices.length,1);
    assert.equal((await revokeRecipientDevice(pool,{
      recipientId:key(),app:'courier',deviceId:created.id
    })).revoked,false);
    assert.equal((await revokeRecipientDevice(pool,{
      recipientId,app:'courier',deviceId:created.id
    })).revoked,true);
    assert.equal((await listRecipientDevices(pool,{
      recipientId,app:'courier'})).devices.length,0);
    assert.equal((await registerDevice(pool,args)).id,created.id);
  }finally{await pool.end();}
});

test('M5 preferences: marketing disabled by default, security overrides opt-outs', 
 {skip:!enabled,timeout:60000},async()=>{
  const pool=db();
  try{
    const recipientId=key(),app='customer' as const;
    const p=await readRecipientPreferences(pool,{recipientId,app});
    assert.equal(p.preferences.length,6);
    assert.ok(p.preferences.filter(x=>x.category==='marketing').every(x=>!x.enabled));
    await setRecipientPreference(pool,{recipientId,app,channel:'email',
      category:'transactional',enabled:false});
    await fail(()=>setRecipientPreference(pool,{recipientId,app,channel:'email',
      category:'security' as never,enabled:false}),
      'NOTIFICATIONS_SECURITY_OPT_OUT_DENIED');
    await registerDevice(pool,{recipientId,app,platform:'web',token:token(),secret});
    assert.equal((await publishNotification(pool,{recipientId,app,
      sourceEventId:key(),eventType:'marketing.promotion'})).suppressed,true);
    await setRecipientPreference(pool,{recipientId,app,channel:'in_app',
      category:'marketing',enabled:true});
    await setRecipientPreference(pool,{recipientId,app,channel:'push',
      category:'marketing',enabled:true});
    const promo=await publishNotification(pool,{recipientId,app,
      sourceEventId:key(),eventType:'marketing.promotion'});
    assert.equal(promo.deliveriesQueued,1);
    const critical=await publishNotification(pool,{recipientId,app,
      sourceEventId:key(),eventType:'identity.new_login'});
    assert.equal(critical.deliveriesQueued,2);
  }finally{await pool.end();}
});

test('M5 inbox: cursor, privacy, read/dismiss and cross-app events', 
 {skip:!enabled,timeout:70000},async()=>{
  const pool=db();
  try{
    const recipientId=key(),sourceEventId=key(),resourceId=key();
    const input={recipientId,sourceEventId,resourceId,
      app:'customer' as const,eventType:'order.confirmed' as const};
    const result=await publishNotification(pool,input);
    assert.equal(result.deliveriesQueued,1);
    const replay=await publishNotification(pool,input);
    assert.equal(replay.replayed,true);
    assert.equal(replay.notification?.id,result.notification?.id);
    await fail(()=>publishNotification(pool,{...input,eventType:'order.delivered'}),
      'NOTIFICATIONS_IDEMPOTENCY_CONFLICT');
    for(const eventType of ['order.accepted','order.preparing','order.ready'] as const)
      await publishNotification(pool,{recipientId,app:'customer',
        sourceEventId:key(),eventType});
    const first=await readInbox(pool,{recipientId,app:'customer',limit:2});
    assert.equal(first.items.length,2);
    assert.equal(first.unreadCount,4);
    const second=await readInbox(pool,{recipientId,app:'customer',
      limit:2,beforeId:first.nextCursor!});
    assert.equal(second.items.length,2);
    assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,4);
    const other=key();
    await fail(()=>readInbox(pool,{recipientId:other,app:'customer',
      beforeId:first.items[0]!.id}),'NOTIFICATIONS_CURSOR_INVALID');
    assert.equal((await markNotificationRead(pool,{
      recipientId:other,app:'customer',notificationId:result.notification!.id
    })).found,false);
    assert.equal((await markNotificationRead(pool,{
      recipientId,app:'customer',notificationId:result.notification!.id
    })).found,true);
    assert.equal((await markAllNotificationsRead(pool,{
      recipientId,app:'customer'})).readCount,3);
    assert.equal((await dismissNotification(pool,{
      recipientId,app:'customer',notificationId:result.notification!.id
    })).found,true);
    assert.equal((await readInbox(pool,{recipientId,app:'customer'})).items.length,3);
    for(const [app,eventType] of [
      ['restaurant','restaurant.new_order'],['courier','courier.offer'],
      ['admin','admin.support_ticket']
    ] as const){
      const owner=key();
      const posted=await publishNotification(pool,{
        recipientId:owner,app,eventType,sourceEventId:key()});
      assert.equal(posted.notification?.eventType,eventType);
      assert.equal((await readInbox(pool,{recipientId:owner,app})).items.length,1);
    }
  }finally{await pool.end();}
});

test('M5 duplicate concurrent events fan out exactly once to email and each device', 
 {skip:!enabled,timeout:70000},async()=>{
  const pool=db();
  try{
    const recipientId=key(),sourceEventId=key();
    await registerDevice(pool,{recipientId,app:'customer',platform:'android',
      token:token(),secret});
    const input={recipientId,sourceEventId,app:'customer' as const,
      eventType:'order.confirmed' as const};
    const results=await Promise.all(Array.from({length:12},()=>
      publishNotification(pool,input)));
    assert.equal(results.filter(x=>!x.replayed).length,1);
    assert.equal(new Set(results.map(x=>x.notification?.id)).size,1);
    assert.equal(results.reduce((n,x)=>n+x.deliveriesQueued,0),2);
    const count=await pool.query(
      'SELECT count(*)::int AS n FROM tala_notifications_v2.deliveries'+
      ' WHERE notification_id=$1',[results[0]!.notification!.id]);
    assert.equal(count.rows[0]?.n,2);
  }finally{await pool.end();}
});
