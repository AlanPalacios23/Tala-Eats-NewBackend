/** M5 LAB3 internal retention sweep. No public HTTP route.
 * Redacts aged payload and revoked FCM token material in bounded batches.
 * Keeps publication receipts and immutable delivery attempts for audit.
 * Does NOT implement a legal account-erasure process across backups.
 */
import type {Pool} from 'pg';
import {NotificationError} from './domain.js';
import {transaction} from './db.js';

export async function redactExpiredNotificationData(pool:Pool,{
  limit=200
}:{limit?:number}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)
    throw new NotificationError('NOTIFICATIONS_RETENTION_LIMIT_INVALID');
  return transaction(pool,async c=>{
    const devices=await c.query(
      "WITH old AS ("+
      " SELECT id FROM tala_notifications_v2.devices "+
      " WHERE revoked_at<clock_timestamp()-interval '30 days' "+
      " AND token_redacted_at IS NULL "+
      " ORDER BY revoked_at,id LIMIT $1 FOR UPDATE SKIP LOCKED"+
      ") UPDATE tala_notifications_v2.devices d SET "+
      " token_digest=replace(gen_random_uuid()::text,'-','')||"+
          "replace(gen_random_uuid()::text,'-',''), "+
      " token_iv=left(replace(gen_random_uuid()::text,'-',''),24),"+
      " token_cipher=replace(gen_random_uuid()::text,'-','')||"+
          "replace(gen_random_uuid()::text,'-',''),"+
      " token_tag=replace(gen_random_uuid()::text,'-',''),"+
      " token_redacted_at=clock_timestamp() "+
      " FROM old WHERE d.id=old.id",[limit]);

    const content=await c.query(
      "WITH old AS ("+
      " SELECT i.id FROM tala_notifications_v2.inbox i "+
      " WHERE i.created_at<clock_timestamp()-interval '180 days' "+
      " AND i.content_redacted_at IS NULL "+
      " AND NOT EXISTS (SELECT 1 FROM tala_notifications_v2.deliveries d "+
      "   WHERE d.notification_id=i.id AND "+
      "     d.status IN ('queued','retry','leased')) "+
      " ORDER BY i.created_at,i.id LIMIT $1 "+
      " FOR UPDATE OF i SKIP LOCKED"+
      ") UPDATE tala_notifications_v2.inbox i SET "+
      " title='Aviso archivado',body='Contenido eliminado por retencion.',"+
      " deep_link='/notificaciones',data='{}'::jsonb,"+
      " visible_in_app=false,dismissed_at=COALESCE("+
      "i.dismissed_at,clock_timestamp()),"+
      " content_redacted_at=clock_timestamp() "+
      " FROM old WHERE i.id=old.id",[limit]);

    return Object.freeze({
      revokedDeviceSecretsRedacted:devices.rowCount??0,
      oldNotificationContentsRedacted:content.rowCount??0,
      auditAttemptsDeleted:0,
      publicationReceiptsDeleted:0
    });
  });
}
