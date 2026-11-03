import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {publishNotification} from '../src/store.js';
import {readNotificationOperations} from '../src/operations.js';

const url=process.env.NOTIFICATIONS_CI_URL??'';
const enabled=/\/tala_notifications_v2_test(?:$|\?)/.test(url);
test('M5 operator metrics: per-channel backlog, no recipients or tokens exposed',
  {skip:!enabled,timeout:60000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:5});
  try{
    const baseline=await readNotificationOperations(pool);
    const recipientId=randomUUID(),sourceEventId=randomUUID();
    const posted=await publishNotification(pool,{
      recipientId,sourceEventId,app:'customer',
      eventType:'order.confirmed'
    });
    assert.equal(posted.deliveriesQueued,1);
    const snapshot=await readNotificationOperations(pool);
    assert.equal(snapshot.deliveries.email.queued,
      baseline.deliveries.email.queued+1);
    assert.equal(snapshot.inbox.stored,baseline.inbox.stored+1);
    assert.ok(snapshot.backlog.due>=baseline.backlog.due+1);
    assert.equal(snapshot.deliverySemantics,'provider_accepted_not_device_receipt');
    const json=JSON.stringify(snapshot);
    assert.ok(!json.includes(recipientId));
    assert.ok(!json.includes(sourceEventId));
    assert.ok(!json.includes('email@example.com'));
    assert.ok(Object.keys(snapshot.deliveries.push).includes('dead_letter'));
    assert.ok(snapshot.last24Hours.acceptedByProviders>=0);
  }finally{await pool.end();}
});
