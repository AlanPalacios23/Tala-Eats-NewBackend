import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {publishNotification} from '../src/store.js';
import {claimDueDeliveries,processDeliveryBatch} from '../src/worker.js';
const url=process.env.NOTIFICATIONS_CI_URL??'';
const enabled=/\/tala_notifications_v2_test(?:$|\?)/.test(url);
test('M5 LAB2: interrupted attempt audited, reclaimed with fresh lease and delivered exactly once',
 {skip:!enabled,timeout:45000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:6});
  try{
    const recipientId=randomUUID();
    const p=await publishNotification(pool,{
      recipientId,sourceEventId:randomUUID(),app:'customer',
      eventType:'order.confirmed'
    });
    assert.equal(p.deliveriesQueued,1);
    const first=(await claimDueDeliveries(pool,{limit:1}))[0]!;
    assert.equal(first.attempts,1);
    await pool.query(
      "UPDATE tala_notifications_v2.deliveries SET "+
      "lease_until=clock_timestamp()-interval '1 second' "+
      "WHERE id=$1",[first.id]);
    const second=(await claimDueDeliveries(pool,{limit:1}))[0]!;
    assert.equal(second.id,first.id);
    assert.notEqual(second.lease_token,first.lease_token);
    assert.equal(second.attempts,2);
    const crashed=await pool.query(
      'SELECT attempt_number,result,error_code FROM '+
      'tala_notifications_v2.delivery_attempts WHERE delivery_id=$1',
      [first.id]);
    assert.deepEqual(crashed.rows,[{
      attempt_number:1,result:'retry',error_code:'LEASE_EXPIRED'
    }]);
    // Simulate worker crash once more, then actual delivery.
    await pool.query(
      "UPDATE tala_notifications_v2.deliveries SET "+
      "lease_until=clock_timestamp()-interval '1 second' "+
      "WHERE id=$1",[second.id]);
    const done=await processDeliveryBatch(pool,{
      secret:randomBytes(32),
      resolveVerifiedEmail:async()=> 'customer@example.com',
      sendEmail:async()=>{},sendPush:async()=>{}
    },{limit:1});
    assert.equal(done.delivered,1);
    const audit=await pool.query(
      'SELECT attempt_number,result,error_code FROM '+
      'tala_notifications_v2.delivery_attempts WHERE delivery_id=$1 '+
      'ORDER BY attempt_number',[first.id]);
    assert.deepEqual(audit.rows.map(x=>[x.attempt_number,x.result,x.error_code]),[
      [1,'retry','LEASE_EXPIRED'],
      [2,'retry','LEASE_EXPIRED'],
      [3,'delivered',null]
    ]);
  }finally{await pool.end();}
});
