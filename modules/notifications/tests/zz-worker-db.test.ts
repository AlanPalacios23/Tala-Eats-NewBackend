import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {publishNotification} from '../src/store.js';
import {registerDevice,setRecipientPreference,revokeRecipientDevice} from '../src/recipients.js';
import {processDeliveryBatch,claimDueDeliveries,requeueDeadLetter,
  DeliveryFailure} from '../src/worker.js';

const url=process.env.NOTIFICATIONS_CI_URL??'';
const enabled=/\/tala_notifications_v2_test(?:$|\?)/.test(url);
const secret=randomBytes(32),key=()=>randomUUID();
const db=()=>new pg.Pool({connectionString:url,max:10});
const token=()=> 'fcm-device-token-abcdefghijklmnopqrstuvwxyz-'+key();
const deps={
  secret,resolveVerifiedEmail:async()=> 'user@example.com',
  sendEmail:async()=>{},sendPush:async()=>{}
};
test('M5 delivery E2E: one event -> one email and one PWA push, immutable audit',
  {skip:!enabled,timeout:70000},async()=>{
  const pool=db();
  try{
    // Tests ONLY; never against an operational M5 database.
    await pool.query('TRUNCATE tala_notifications_v2.delivery_attempts,'+
      'tala_notifications_v2.deliveries,tala_notifications_v2.inbox,'+
      'tala_notifications_v2.devices,tala_notifications_v2.preferences'+
      ' RESTART IDENTITY CASCADE');
    const recipientId=key(),sourceEventId=key();
    const device=await registerDevice(pool,{recipientId,app:'customer',
      platform:'web',token:token(),secret});
    assert.ok(device.id);
    const posted=await publishNotification(pool,{recipientId,sourceEventId,
      app:'customer',eventType:'order.confirmed'});
    assert.equal(posted.deliveriesQueued,2);
    const emails:string[]=[],pushes:string[]=[];
    const done=await processDeliveryBatch(pool,{
      ...deps,resolveVerifiedEmail:async(id,app)=>{
        assert.equal(id,recipientId);assert.equal(app,'customer');
        return 'verified@example.com';
      },
      sendEmail:async(msg)=>{emails.push(msg.idempotencyKey);
        assert.equal(msg.to,'verified@example.com');},
      sendPush:async(msg)=>{pushes.push(msg.platform);
        assert.equal(msg.eventType,'order.confirmed');
        assert.ok(msg.token.startsWith('fcm-device-token-'));}
    });
    assert.deepEqual({claimed:done.claimed,delivered:done.delivered},
      {claimed:2,delivered:2});
    assert.equal(emails.length,1);
    assert.deepEqual(pushes,['web']);
    const deliveries=await pool.query(
      'SELECT status,attempts FROM tala_notifications_v2.deliveries'+
      ' WHERE notification_id=$1',[posted.notification!.id]);
    assert.ok(deliveries.rows.every(x=>x.status==='delivered'&&x.attempts===1));
    const audit=await pool.query(
      'SELECT result,error_code FROM tala_notifications_v2.delivery_attempts');
    assert.equal(audit.rows.length,2);
    assert.ok(audit.rows.every(x=>x.result==='delivered'&&x.error_code===null));
    await assert.rejects(pool.query(
      "UPDATE tala_notifications_v2.delivery_attempts SET result='retry'"),
      e=>e instanceof Error&&e.message.includes('NOTIFICATIONS_ATTEMPTS_IMMUTABLE'));
    const raw=await pool.query('SELECT token_cipher FROM tala_notifications_v2.devices');
    assert.ok(!JSON.stringify(raw.rows).includes('fcm-device-token-'));
    assert.equal((await processDeliveryBatch(pool,deps)).claimed,0);
  }finally{await pool.end();}
});
test('M5 transient email failure retries with backoff; permanent failure deadletters and can requeue',
  {skip:!enabled,timeout:70000},async()=>{
  const pool=db();
  try{
    const recipientId=key();
    const posted=await publishNotification(pool,{
      recipientId,sourceEventId:key(),app:'customer',eventType:'order.confirmed'
    });
    assert.equal(posted.deliveriesQueued,1);
    const attempt1=await processDeliveryBatch(pool,{
      ...deps,sendEmail:async()=>{
        throw new DeliveryFailure('EMAIL_PROVIDER_TEMPORARY',false);
      }},{limit:1});
    assert.equal(attempt1.retried,1);
    const pending=await pool.query(
      'SELECT id,status,attempts,next_attempt_at>clock_timestamp() AS delayed'+
      ' FROM tala_notifications_v2.deliveries WHERE notification_id=$1',
      [posted.notification!.id]);
    assert.equal(pending.rows[0]?.status,'retry');
    assert.equal(pending.rows[0]?.delayed,true);
    await pool.query(
      "UPDATE tala_notifications_v2.deliveries SET"+
      " next_attempt_at=clock_timestamp()-interval '1 second'"+
      " WHERE id=$1",[pending.rows[0].id]);
    const attempt2=await processDeliveryBatch(pool,deps,{limit:1});
    assert.equal(attempt2.delivered,1);
    const r=await pool.query(
      'SELECT attempt_number,result,retry_cycle FROM tala_notifications_v2.delivery_attempts'+
      ' WHERE delivery_id=$1 ORDER BY retry_cycle,attempt_number',[pending.rows[0].id]);
    assert.deepEqual(r.rows.map(x=>x.result),['retry','delivered']);
    const next=await publishNotification(pool,{
      recipientId,sourceEventId:key(),app:'customer',eventType:'order.cancelled'
    });
    const dead=await processDeliveryBatch(pool,{
      ...deps,sendEmail:async()=>{
        throw new DeliveryFailure('EMAIL_PROVIDER_REJECTED',true);
      }},{limit:1});
    assert.equal(dead.deadLetter,1);
    const row=await pool.query(
      'SELECT id,status FROM tala_notifications_v2.deliveries'+
      ' WHERE notification_id=$1',[next.notification!.id]);
    assert.equal(row.rows[0]?.status,'dead_letter');
    assert.equal((await requeueDeadLetter(pool,{
      deliveryId:row.rows[0].id})).requeued,true);
    assert.equal((await processDeliveryBatch(pool,deps,{limit:1})).delivered,1);
    const attempts=await pool.query(
      'SELECT retry_cycle,attempt_number,result FROM tala_notifications_v2.delivery_attempts'+
      ' WHERE delivery_id=$1 ORDER BY retry_cycle,attempt_number',
      [row.rows[0].id]);
    assert.deepEqual(attempts.rows.map(x=>[x.retry_cycle,x.attempt_number,x.result]),
      [[0,1,'dead_letter'],[1,1,'delivered']]);
  }finally{await pool.end();}
});
test('M5 opt-outs after enqueue and revoked devices are suppressed at send time',
  {skip:!enabled,timeout:70000},async()=>{
  const pool=db();
  try{
    const recipientId=key();
    const device=await registerDevice(pool,{
      recipientId,app:'customer',platform:'android',token:token(),secret});
    const posted=await publishNotification(pool,{
      recipientId,sourceEventId:key(),app:'customer',eventType:'order.confirmed'
    });
    assert.equal(posted.deliveriesQueued,2);
    await setRecipientPreference(pool,{recipientId,app:'customer',
      channel:'email',category:'transactional',enabled:false});
    await revokeRecipientDevice(pool,{
      recipientId,app:'customer',deviceId:device.id
    });
    const result=await processDeliveryBatch(pool,{
      ...deps,sendEmail:async()=>{throw Error('NOT_CALLED');},
      sendPush:async()=>{throw Error('NOT_CALLED');}
    });
    assert.equal(result.suppressed,2);
    assert.equal(result.delivered,0);
    assert.equal(result.retried,0);
  }finally{await pool.end();}
});
test('M5 exhausted worker crash lease becomes dead-letter, never stays leased forever',
  {skip:!enabled,timeout:70000},async()=>{
  const pool=db();
  try{
    const recipientId=key();
    await publishNotification(pool,{recipientId,sourceEventId:key(),
      app:'customer',eventType:'order.confirmed'});
    const claims=await claimDueDeliveries(pool,{limit:1});
    assert.equal(claims.length,1);
    const target=claims[0]!;
    await pool.query(
      "UPDATE tala_notifications_v2.deliveries SET attempts=5,"+
      " lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [target.id]);
    const fresh=await claimDueDeliveries(pool,{limit:1});
    assert.equal(fresh.length,0);
    const old=await pool.query(
      'SELECT status,lease_token,last_error_code FROM tala_notifications_v2.deliveries WHERE id=$1',
      [target.id]);
    assert.equal(old.rows[0]?.status,'dead_letter');
    assert.equal(old.rows[0]?.lease_token,null);
    assert.equal(old.rows[0]?.last_error_code,'LEASE_EXHAUSTED');
    assert.equal((await requeueDeadLetter(pool,{deliveryId:target.id})).requeued,true);
  }finally{await pool.end();}
});


test('M5 explicitly UNREGISTERED push token is revoked; subsequent jobs skip it',
  {skip:!enabled,timeout:70000},async()=>{
  const pool=db();
  try{
    const recipientId=key();
    const device=await registerDevice(pool,{
      recipientId,app:'courier',platform:'android',token:token(),secret});
    const posted=await publishNotification(pool,{
      recipientId,sourceEventId:key(),app:'courier',eventType:'courier.offer'});
    assert.equal(posted.deliveriesQueued,1);
    const results=await processDeliveryBatch(pool,{
      ...deps,sendPush:async msg=>{
        if(msg.notificationId===posted.notification?.id)
          throw new DeliveryFailure('FCM_UNREGISTERED',true);
      }},{limit:50});
    assert.ok(results.deadLetter>=1);
    const delivery=await pool.query(
      'SELECT status,last_error_code FROM tala_notifications_v2.deliveries '+
      'WHERE notification_id=$1',[posted.notification!.id]);
    assert.equal(delivery.rows[0]?.status,'dead_letter');
    assert.equal(delivery.rows[0]?.last_error_code,'FCM_UNREGISTERED');
    const stored=await pool.query(
      'SELECT revoked_at FROM tala_notifications_v2.devices WHERE id=$1',
      [device.id]);
    assert.ok(stored.rows[0]?.revoked_at instanceof Date);
    const next=await publishNotification(pool,{
      recipientId,sourceEventId:key(),app:'courier',eventType:'courier.offer'});
    assert.equal(next.deliveriesQueued,0);
    assert.ok(next.notification);
    const hist=await pool.query(
      'SELECT result,error_code FROM tala_notifications_v2.delivery_attempts '+
      'WHERE delivery_id IN (SELECT id FROM tala_notifications_v2.deliveries '+
      'WHERE notification_id=$1)',[posted.notification!.id]);
    assert.deepEqual(hist.rows.map(x=>x.error_code),['FCM_UNREGISTERED']);
  }finally{await pool.end();}
});


test('M5 durable outbox honors provider Retry-After without shortening exponential delay',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=db();
  try{
    const posted=await publishNotification(pool,{
      recipientId:key(),sourceEventId:key(),app:'customer',
      eventType:'order.confirmed'
    });
    const result=await processDeliveryBatch(pool,{
      ...deps,sendEmail:async msg=>{
        if(msg.notificationId===posted.notification?.id)
          throw new DeliveryFailure('EMAIL_PROVIDER_TEMPORARY',false,120);
      }
    },{limit:50});
    assert.ok(result.retried>=1);
    const row=await pool.query(
      'SELECT status,attempts,extract(epoch FROM '+
      '(next_attempt_at-clock_timestamp())) AS seconds_left '+
      'FROM tala_notifications_v2.deliveries WHERE notification_id=$1',
      [posted.notification!.id]);
    assert.equal(row.rows[0]?.status,'retry');
    assert.equal(row.rows[0]?.attempts,1);
    assert.ok(Number(row.rows[0]?.seconds_left)>=110,
      'Provider-specified 120s retry window must persist in PostgreSQL');
    assert.ok(Number(row.rows[0]?.seconds_left)<=125);
  }finally{await pool.end();}
});
