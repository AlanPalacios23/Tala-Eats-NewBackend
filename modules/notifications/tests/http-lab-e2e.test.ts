import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {createNotificationsLabHttpServer} from '../src/http-lab.js';
import {publishNotification} from '../src/store.js';
const url=process.env.NOTIFICATIONS_CI_URL??'';
const enabled=/\/tala_notifications_v2_test(?:$|\?)/.test(url);
const key=()=>randomUUID();
const deviceToken='firebase-registration-token-abcdefghijklmnopqrstuvwxyz';
test('M5 loopback HTTP end-to-end: authenticated private inbox, consent and devices',
  {skip:!enabled,timeout:70000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:12});
  const recipientId=key(),other=key(),bearer='test-'+key();
  const server=createNotificationsLabHttpServer({
    pool,deviceSecret:randomBytes(32),
    authenticate:async req=>req.headers.authorization==='Bearer '+bearer
      ?{recipientId,app:'customer'}:null
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  async function request(method:string,path:string,data?:unknown,authorization?:string){
    const response=await fetch(base+path,{
      method,headers:{
        ...(data!==undefined?{'content-type':'application/json'}:{}),
        ...(authorization?{authorization:'Bearer '+authorization}:{})
      },...(data!==undefined?{body:JSON.stringify(data)}:{})
    });
    return {status:response.status,
      result:await response.json() as Record<string,unknown>,
      headers:response.headers};
  }
  try{
    const ev=await publishNotification(pool,{recipientId,
      sourceEventId:key(),app:'customer',eventType:'order.confirmed'});
    const stranger=await publishNotification(pool,{recipientId:other,
      sourceEventId:key(),app:'customer',eventType:'order.cancelled'});
    assert.ok(stranger.notification);
    assert.equal((await request('GET','/v1/notifications')).status,401);
    const inbox=await request('GET','/v1/notifications',undefined,bearer);
    assert.equal(inbox.status,200);
    assert.equal((inbox.result.items as unknown[]).length,1);
    assert.equal(inbox.result.unreadCount,1);
    assert.equal(inbox.headers.get('cache-control'),'private, no-store');
    assert.equal(inbox.headers.get('access-control-allow-origin'),null);
    assert.equal(JSON.stringify(inbox.result).includes(other),false);
    const mark=await request('POST','/v1/notifications/read',{
      notificationId:ev.notification!.id
    },bearer);
    assert.equal(mark.status,200);
    const own=await request('POST','/v1/notifications/read',{
      notificationId:stranger.notification!.id
    },bearer);
    assert.equal(own.result.found,false);
    const settings=await request('GET','/v1/notifications/preferences',undefined,bearer);
    assert.equal((settings.result.preferences as unknown[]).length,6);
    const consent=await request('PUT','/v1/notifications/preferences',{
      channel:'push',category:'marketing',enabled:true
    },bearer);
    assert.equal(consent.result.enabled,true);
    assert.equal((await request('PUT','/v1/notifications/preferences',{
      channel:'push',category:'security',enabled:false
    },bearer)).status,400);
    const created=await request('POST','/v1/notifications/devices',{
      platform:'web',token:deviceToken
    },bearer);
    assert.equal(created.status,201);
    const deviceId=String(created.result.id);
    assert.equal(JSON.stringify(created.result).includes(deviceToken),false);
    const devices=await request('GET','/v1/notifications/devices',undefined,bearer);
    assert.equal((devices.result.devices as unknown[]).length,1);
    assert.equal(JSON.stringify(devices.result).includes(deviceToken),false);
    assert.equal((await request('POST','/v1/notifications/devices',{
      platform:'web',token:deviceToken,recipientId:other
    },bearer)).status,400);
    assert.equal((await request('POST','/v1/notifications/devices/revoke',{
      deviceId
    },bearer)).result.revoked,true);
    assert.equal((await request('POST','/v1/notifications/dismiss',{
      notificationId:ev.notification!.id
    },bearer)).result.found,true);
    assert.equal((await request('GET','/v1/notifications',undefined,bearer)
      .then(x=>x.result.items) as unknown[]).length,0);
  }finally{
    await new Promise<void>((resolve,reject)=>
      server.close(error=>error?reject(error):resolve()));
    await pool.end();
  }
});
