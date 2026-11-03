import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {publishNotification,readInbox} from '../src/store.js';
import type {App,EventType} from '../src/domain.js';

const url=process.env.NOTIFICATIONS_CI_URL??'';
const enabled=/\/tala_notifications_v2_test(?:$|\?)/.test(url);
test('M5 load gate: 160 concurrent publications, 4 apps, 80 distinct events, no double fanout',
 {skip:!enabled,timeout:120000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:24});
  try{
    const sources:Array<{app:App,eventType:EventType,recipientId:string}>=[
      {app:'customer',eventType:'order.confirmed',recipientId:randomUUID()},
      {app:'restaurant',eventType:'restaurant.new_order',recipientId:randomUUID()},
      {app:'courier',eventType:'courier.earnings_ready',recipientId:randomUUID()},
      {app:'admin',eventType:'admin.support_ticket',recipientId:randomUUID()}
    ];
    const all=sources.flatMap(x=>Array.from({length:20},()=>({
      ...x,sourceEventId:randomUUID(),resourceId:randomUUID()
    })));
    const attempts=all.flatMap(x=>[publishNotification(pool,x),
      publishNotification(pool,x)]);
    const done=await Promise.all(attempts);
    assert.equal(done.length,160);
    assert.equal(done.filter(x=>x.replayed).length,80);
    assert.equal(done.filter(x=>!x.replayed).length,80);
    assert.equal(done.reduce((n,x)=>n+x.deliveriesQueued,0),80);
    assert.equal(new Set(done.map(x=>x.notification?.id)).size,80);
    const recipients=sources.map(x=>x.recipientId);
    const result=await pool.query<{records:number,jobs:number}>(`
      SELECT
        (SELECT count(*)::int FROM tala_notifications_v2.inbox
         WHERE recipient_id=ANY($1::uuid[])) AS records,
        (SELECT count(*)::int FROM tala_notifications_v2.deliveries d
         JOIN tala_notifications_v2.inbox i ON i.id=d.notification_id
         WHERE i.recipient_id=ANY($1::uuid[])) AS jobs`,[recipients]);
    assert.deepEqual(result.rows,[{records:80,jobs:80}]);
    for(const item of sources){
      const list=await readInbox(pool,{recipientId:item.recipientId,
        app:item.app,limit:50});
      assert.equal(list.items.length,20);
      assert.equal(list.unreadCount,20);
      assert.equal(list.nextCursor,null);
    }
  }finally{await pool.end();}
});
