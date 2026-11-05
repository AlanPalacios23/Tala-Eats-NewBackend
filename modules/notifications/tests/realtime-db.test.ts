import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {publishNotification,readInbox} from '../src/store.js';
import {subscribeInboxHints} from '../src/realtime.js';
const url=process.env.NOTIFICATIONS_CI_URL??'';
const enabled=/\/tala_notifications_v2_test(?:$|\?)/.test(url);
test('M5 real-time inbox hint is sent after commit and scoped by user/app',
 {skip:!enabled,timeout:30000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:6});
  const recipientId=randomUUID(),otherId=randomUUID();
  const seen:string[]=[];
  let deliver:(id:string)=>void=()=>{};
  const received=new Promise<string>(resolve=>{deliver=resolve;});
  const listener=await subscribeInboxHints(pool,{
    recipientId,app:'restaurant',onHint:hint=>{
      seen.push(hint.notificationId);deliver(hint.notificationId);
    }
  });
  try{
    await publishNotification(pool,{recipientId:otherId,
      sourceEventId:randomUUID(),app:'restaurant',
      eventType:'restaurant.new_order'});
    const posted=await publishNotification(pool,{
      recipientId,sourceEventId:randomUUID(),
      app:'restaurant',eventType:'restaurant.new_order'
    });
    const notificationId=await Promise.race([
      received,new Promise<string>((_,reject)=>setTimeout(
        ()=>reject(Error('NOTIFICATIONS_HINT_TIMEOUT')),3000))
    ]);
    assert.equal(notificationId,posted.notification?.id);
    assert.deepEqual(seen,[notificationId]);
    const inbox=await readInbox(pool,{recipientId,app:'restaurant'});
    assert.ok(inbox.items.some(x=>x.id===notificationId));
    assert.equal((await readInbox(pool,{recipientId:otherId,app:'restaurant'}))
      .items.length,1);
  }finally{
    await listener.close();
    await pool.end();
  }
});
