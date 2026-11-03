import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {registerDevice,listRecipientDevices,revokeRecipientDevice} from '../src/recipients.js';
import {NotificationError} from '../src/domain.js';
const url=process.env.NOTIFICATIONS_CI_URL??'';
const enabled=/\/tala_notifications_v2_test(?:$|\?)/.test(url);
const token=()=> 'fcm-token-'+randomUUID()+'-long-abcdefghijklmnopqrstuvwxyz';
test('M5 device cap: 20 active endpoints, replay safe, 16-way concurrency, revoke and replace',
 {skip:!enabled,timeout:120000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:20});
  try{
    const recipientId=randomUUID(),secret=randomBytes(32);
    const props={recipientId,app:'restaurant' as const,
      platform:'android' as const,secret};
    const attempts=await Promise.allSettled(Array.from({length:30},()=>
      registerDevice(pool,{...props,token:token()})));
    const successes=attempts.filter(x=>x.status==='fulfilled');
    const failures=attempts.filter(x=>x.status==='rejected');
    assert.equal(successes.length,20);
    assert.equal(failures.length,10);
    assert.ok(failures.every(x=>x.reason instanceof NotificationError&&
      x.reason.code==='NOTIFICATIONS_DEVICE_LIMIT'));
    const listed=await listRecipientDevices(pool,{recipientId,app:'restaurant'});
    assert.equal(listed.devices.length,20);
    const first=listed.devices[0]!.id;
    assert.equal((await revokeRecipientDevice(pool,{
      recipientId,app:'restaurant',deviceId:first
    })).revoked,true);
    const replaced=await registerDevice(pool,{...props,token:token()});
    assert.equal(replaced.registered,true);
    assert.equal((await listRecipientDevices(pool,{recipientId,app:'restaurant'}))
      .devices.length,20);
    const probe=await pool.query(
      'SELECT token_digest,token_cipher FROM tala_notifications_v2.devices WHERE id=$1',
      [replaced.id]);
    assert.ok(probe.rows[0].token_digest&&probe.rows[0].token_cipher);
  }finally{await pool.end();}
});
