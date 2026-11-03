/** M5 recipient-owned preferences and encrypted device registrations.
 * These functions are INTERNAL and expect host-verified identity.
 */
import type {Pool,PoolClient} from 'pg';
import {NotificationError,uuid,appValue,channelValue,categoryValue,
  type App,type Channel,type Category} from './domain.js';
import {transaction} from './db.js';
import {sealDeviceToken,platformValue,type Platform} from './crypto.js';
type PreferenceCategory=Exclude<Category,'security'>;
function preferenceCategory(v:unknown):PreferenceCategory{
  const cat=categoryValue(v);
  if(cat==='security')throw new NotificationError('NOTIFICATIONS_SECURITY_OPT_OUT_DENIED');
  return cat;
}
export async function setRecipientPreference(pool:Pool,{
  recipientId,app,channel,category,enabled
}:{recipientId:string,app:App,channel:Channel,
  category:PreferenceCategory,enabled:boolean}){
  const id=uuid(recipientId),scope=appValue(app),ch=channelValue(channel);
  const cat=preferenceCategory(category);
  if(typeof enabled!=='boolean')throw new NotificationError('NOTIFICATIONS_PREFERENCE_INVALID');
  return transaction(pool,async c=>{
    const r=await c.query<{enabled:boolean}>(`
      INSERT INTO tala_notifications_v2.preferences
        (recipient_id,app,channel,category,enabled)
      VALUES($1::uuid,$2,$3,$4,$5)
      ON CONFLICT(recipient_id,app,channel,category)
      DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=clock_timestamp()
      RETURNING enabled`,[id,scope,ch,cat,enabled]);
    return Object.freeze({recipientId:id,app:scope,
      channel:ch,category:cat,enabled:r.rows[0]!.enabled});
  });
}
export async function readRecipientPreferences(pool:Pool,{
  recipientId,app
}:{recipientId:string,app:App}){
  const id=uuid(recipientId),scope=appValue(app);
  return transaction(pool,async c=>{
    const r=await c.query<{channel:Channel,category:PreferenceCategory,enabled:boolean}>(`
      SELECT channel,category,enabled FROM tala_notifications_v2.preferences
      WHERE recipient_id=$1::uuid AND app=$2`,[id,scope]);
    const values=(['in_app','push','email'] as const).flatMap(channel=>
      (['transactional','marketing'] as const).map(category=>{
        const found=r.rows.find(x=>x.channel===channel&&x.category===category);
        return Object.freeze({channel,category,
          enabled:found?.enabled??(category==='transactional')});
      }));
    return Object.freeze({recipientId:id,app:scope,preferences:Object.freeze(values)});
  },true);
}
export async function isEnabled(c:PoolClient,{
  recipientId,app,channel,category
}:{recipientId:string,app:App,channel:Channel,category:Category}){
  if(category==='security')return true;
  const r=await c.query<{enabled:boolean}>(`
    SELECT enabled FROM tala_notifications_v2.preferences
    WHERE recipient_id=$1::uuid AND app=$2 AND channel=$3 AND category=$4`,
    [recipientId,app,channel,category]);
  return r.rows[0]?.enabled??(category==='transactional');
}
type DeviceRow={id:string,recipient_id:string,app:App,platform:Platform,
  created_at:Date,last_seen_at:Date,revoked_at:Date|null};
export async function registerDevice(pool:Pool,{
  recipientId,app,platform,token,secret
}:{recipientId:string,app:App,platform:Platform,token:string,secret:Buffer}){
  const id=uuid(recipientId),scope=appValue(app),pl=platformValue(platform);
  const sealed=sealDeviceToken({token,recipientId:id,app:scope,platform:pl,secret});
  return transaction(pool,async c=>{
    const created=await c.query<DeviceRow>(`
      INSERT INTO tala_notifications_v2.devices(recipient_id,app,platform,
        token_digest,token_iv,token_cipher,token_tag)
      VALUES($1::uuid,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(token_digest) DO NOTHING
      RETURNING id,recipient_id,app,platform,created_at,last_seen_at,revoked_at`,
      [id,scope,pl,sealed.tokenDigest,sealed.tokenIv,sealed.tokenCipher,sealed.tokenTag]);
    let row=created.rows[0];
    if(!row){
      const old=await c.query<DeviceRow>(`
        SELECT id,recipient_id,app,platform,created_at,last_seen_at,revoked_at
        FROM tala_notifications_v2.devices WHERE token_digest=$1 FOR UPDATE`,
        [sealed.tokenDigest]);
      row=old.rows[0];
      if(!row||row.recipient_id!==id||row.app!==scope||row.platform!==pl)
        throw new NotificationError('NOTIFICATIONS_DEVICE_OWNERSHIP_CONFLICT');
      await c.query(`
        UPDATE tala_notifications_v2.devices SET revoked_at=NULL,
        last_seen_at=clock_timestamp(),token_iv=$2,token_cipher=$3,token_tag=$4
        WHERE id=$1::uuid`,
        [row.id,sealed.tokenIv,sealed.tokenCipher,sealed.tokenTag]);
    }
    return Object.freeze({id:row!.id,recipientId:id,app:scope,platform:pl,registered:true});
  });
}
export async function listRecipientDevices(pool:Pool,{
  recipientId,app
}:{recipientId:string,app:App}){
  const id=uuid(recipientId),scope=appValue(app);
  return transaction(pool,async c=>{
    const r=await c.query<DeviceRow>(`
      SELECT id,recipient_id,app,platform,created_at,last_seen_at,revoked_at
      FROM tala_notifications_v2.devices
      WHERE recipient_id=$1::uuid AND app=$2 AND revoked_at IS NULL
      ORDER BY last_seen_at DESC,id LIMIT 100`,[id,scope]);
    return Object.freeze({devices:Object.freeze(r.rows.map(x=>Object.freeze({
      id:x.id,platform:x.platform,lastSeenAt:x.last_seen_at.toISOString()
    })))});
  },true);
}
export async function revokeRecipientDevice(pool:Pool,{
  recipientId,app,deviceId
}:{recipientId:string,app:App,deviceId:string}){
  const id=uuid(recipientId),scope=appValue(app),target=uuid(deviceId);
  return transaction(pool,async c=>{
    const r=await c.query(`
      UPDATE tala_notifications_v2.devices SET revoked_at=clock_timestamp()
      WHERE id=$1::uuid AND recipient_id=$2::uuid AND app=$3
        AND revoked_at IS NULL`,[target,id,scope]);
    return Object.freeze({revoked:r.rowCount===1});
  });
}
