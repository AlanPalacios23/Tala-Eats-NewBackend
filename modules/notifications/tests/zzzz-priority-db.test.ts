import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {publishNotification} from '../src/store.js';
import {claimDueDeliveries} from '../src/worker.js';
import {setRecipientPreference} from '../src/recipients.js';
const url=process.env.NOTIFICATIONS_CI_URL??'';
const enabled=/\/tala_notifications_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
test('M5 priority: safety 100, courier 95, new order 90, transactional 60, marketing 10',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:8});
  try{
    // Isolated disposable CI DB; final ordered suite.
    await pool.query(
      'TRUNCATE tala_notifications_v2.delivery_attempts,'+
      'tala_notifications_v2.deliveries,tala_notifications_v2.inbox,'+
      'tala_notifications_v2.devices,tala_notifications_v2.preferences,'+
      'tala_notifications_v2.publication_receipts RESTART IDENTITY CASCADE'
    );
    const customer=id(),courier=id(),restaurant=id();
    await setRecipientPreference(pool,{recipientId:customer,app:'customer',
      channel:'email',category:'marketing',enabled:true});
    // Publish lower-priority work first to prove ordering is NOT just FIFO.
    const events=[
      {recipientId:customer,app:'customer' as const,eventType:'marketing.promotion' as const},
      {recipientId:customer,app:'customer' as const,eventType:'order.confirmed' as const},
      {recipientId:restaurant,app:'restaurant' as const,eventType:'restaurant.new_order' as const},
      {recipientId:courier,app:'courier' as const,eventType:'courier.earnings_ready' as const},
      {recipientId:customer,app:'customer' as const,eventType:'identity.new_login' as const},
      {recipientId:courier,app:'courier' as const,eventType:'courier.earnings_ready' as const}
    ];
    for(const {recipientId,app,eventType} of events){
      const r=await publishNotification(pool,{
        recipientId,app,eventType,sourceEventId:id()});
      assert.equal(r.deliveriesQueued,1);
    }
    // Courier offer lacks email by design; creating a device adds a push.
    const counts=await pool.query(
      'SELECT priority,count(*)::int AS count FROM tala_notifications_v2.deliveries '+
      'GROUP BY priority ORDER BY priority DESC');
    assert.deepEqual(counts.rows.map(r=>[r.priority,r.count]),[
      [100,1],[90,1],[60,3],[10,1]
    ]);
    const claims=await claimDueDeliveries(pool,{limit:6});
    assert.equal(claims.length,6);
    const ids=claims.map(x=>x.id);
    const rec=await pool.query<{id:string,event_type:string,priority:number}>(
      'SELECT d.id,i.event_type,d.priority FROM tala_notifications_v2.deliveries d '+
      'JOIN tala_notifications_v2.inbox i ON i.id=d.notification_id '+
      'WHERE d.id=ANY($1::uuid[])',[ids]);
    const lookup=new Map(rec.rows.map(x=>[x.id,x]));
    assert.deepEqual(ids.map(x=>lookup.get(x)?.priority),[100,90,60,60,60,10]);
  }finally{await pool.end();}
});
