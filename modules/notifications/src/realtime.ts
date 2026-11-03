/** M5 PostgreSQL realtime hints. NOT a durable queue or public websocket.
 * Every observer must authenticate recipient/app in its host gateway.
 * Always reload the inbox after reconnect or receiving a hint.
 */
import type {Pool,Notification} from 'pg';
import {NotificationError,appValue,uuid,type App} from './domain.js';
export type InboxHint={notificationId:string,recipientId:string,app:App};
export async function subscribeInboxHints(pool:Pool,{
  recipientId,app,onHint
}:{recipientId:string,app:App,onHint:(hint:InboxHint)=>void}){
  const recipient=uuid(recipientId),audience=appValue(app);
  if(typeof onHint!=='function')
    throw new NotificationError('NOTIFICATIONS_SUBSCRIBER_INVALID');
  const c=await pool.connect();
  let closed=false;
  const handler=(event:Notification)=>{
    if(event.channel!=='tala_notifications_v2_new_inbox'||!event.payload)return;
    try{
      const value=JSON.parse(event.payload) as InboxHint;
      if(value.recipientId!==recipient||value.app!==audience)return;
      const notificationId=uuid(value.notificationId);
      // Hint is not trusted data; caller must fetch authenticated inbox.
      onHint({notificationId,recipientId:recipient,app:audience});
    }catch{/* corrupted or foreign NOTIFY is ignored */}
  };
  try{
    const db=await c.query<{name:string}>('SELECT current_database() AS name');
    if(!['tala_notifications_v2_test','tala_notifications_v2_lab'].includes(
      db.rows[0]?.name??''))
      throw new NotificationError('NOTIFICATIONS_LAB_ONLY');
    c.on('notification',handler);
    await c.query('LISTEN tala_notifications_v2_new_inbox');
    return Object.freeze({close:async()=>{
      if(closed)return;
      closed=true;
      c.removeListener('notification',handler);
      try{await c.query('UNLISTEN tala_notifications_v2_new_inbox');}
      finally{c.release();}
    }});
  }catch(error){
    c.removeListener('notification',handler);
    c.release();
    throw error;
  }
}
