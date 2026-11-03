/**
 * M4 identity-only retention, LAB. One-shot internal maintenance for a future
 * scheduled worker. No public endpoint and no audit record deletion.
 * Actual backups/replicas must follow a separate retention policy.
 */
import type {Pool} from 'pg';
import {UsersError} from './domain.js';
export async function cleanupLabExpiredIdentityData(pool:Pool){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='10000ms'");
    await c.query("SET LOCAL lock_timeout='3000ms'");
    const db=await c.query<{name:string}>('SELECT current_database() AS name');
    if(!['tala_users_v2_test','tala_users_v2_lab'].includes(db.rows[0]?.name??''))
      throw new UsersError('USERS_LAB_ONLY');
    const sessions=await c.query(
      "DELETE FROM tala_users_v2.sessions WHERE "+
      "(revoked_at IS NOT NULL AND revoked_at<clock_timestamp()-interval '30 days')"+
      " OR expires_at<clock_timestamp()-interval '30 days'");
    const verification=await c.query(
      "DELETE FROM tala_users_v2.email_challenges WHERE "+
      "expires_at<clock_timestamp()-interval '7 days'");
    const recovery=await c.query(
      "DELETE FROM tala_users_v2.password_recovery WHERE "+
      "expires_at<clock_timestamp()-interval '7 days'");
    const unconfirmedTotp=await c.query(
      "DELETE FROM tala_users_v2.user_totp WHERE enabled_at IS NULL"+
      " AND updated_at<clock_timestamp()-interval '1 day'");
    await c.query('COMMIT');
    return Object.freeze({
      sessionsDeleted:sessions.rowCount??0,
      expiredEmailProofsDeleted:verification.rowCount??0,
      expiredRecoveryProofsDeleted:recovery.rowCount??0,
      abandonedTotpEnrollmentsDeleted:unconfirmedTotp.rowCount??0,
      auditRowsDeleted:0
    });
  }catch(error){
    await c.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{c.release();}
}
