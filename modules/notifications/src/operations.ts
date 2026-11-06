/** Internal, PII-free M5 operator counters. Not an end-user API. */
import type {Pool} from 'pg';
import {NotificationError} from './domain.js';
import {transaction} from './db.js';
const STATES=['queued','leased','retry','delivered','suppressed','dead_letter'] as const;
const CHANNELS=['email','push'] as const;
type State=(typeof STATES)[number];
type Channel=(typeof CHANNELS)[number];

export async function readNotificationOperations(pool:Pool){
  return transaction(pool,async c=>{
    const rows=await c.query<{channel:Channel,status:State,count:number}>(
      "SELECT channel,status,count(*)::int AS count "+
      "FROM tala_notifications_v2.deliveries GROUP BY channel,status");
    const totals=Object.fromEntries(CHANNELS.map(ch=>[
      ch,Object.fromEntries(STATES.map(status=>[status,0]))
    ])) as Record<Channel,Record<State,number>>;
    for(const row of rows.rows){
      if(!CHANNELS.includes(row.channel)||!STATES.includes(row.status)||
         !Number.isSafeInteger(row.count)||row.count<0)
        throw new NotificationError('NOTIFICATIONS_OPERATIONS_INVALID');
      totals[row.channel][row.status]=row.count;
    }
    const current=await c.query<{
      due:number,expired_leases:number,oldest_due_seconds:number|null,
      last_day_delivered:number,last_day_failed:number
    }>(
      "SELECT "+
      "(SELECT count(*)::int FROM tala_notifications_v2.deliveries "+
        "WHERE status IN ('queued','retry') AND "+
        "next_attempt_at<=clock_timestamp()) AS due,"+
      "(SELECT count(*)::int FROM tala_notifications_v2.deliveries "+
        "WHERE status='leased' AND lease_until<=clock_timestamp()) "+
        "AS expired_leases,"+
      "(SELECT floor(extract(epoch FROM "+
        "clock_timestamp()-min(next_attempt_at)))::int "+
        "FROM tala_notifications_v2.deliveries "+
        "WHERE status IN ('queued','retry') "+
        "AND next_attempt_at<=clock_timestamp()) AS oldest_due_seconds,"+
      "(SELECT count(*)::int FROM tala_notifications_v2.delivery_attempts "+
        "WHERE result='delivered' AND "+
        "created_at>clock_timestamp()-interval '24 hours') "+
        "AS last_day_delivered,"+
      "(SELECT count(*)::int FROM tala_notifications_v2.delivery_attempts "+
        "WHERE result IN ('retry','dead_letter') AND "+
        "created_at>clock_timestamp()-interval '24 hours') "+
        "AS last_day_failed");
    const snapshot=current.rows[0]!;
    const inbox=await c.query<{stored:number,unread:number,hidden:number}>(
      "SELECT count(*)::int AS stored,"+
      "count(*) FILTER(WHERE visible_in_app AND read_at IS NULL "+
        "AND dismissed_at IS NULL)::int AS unread,"+
      "count(*) FILTER(WHERE NOT visible_in_app)::int AS hidden "+
      "FROM tala_notifications_v2.inbox");
    return Object.freeze({
      deliveries:Object.freeze({
        email:Object.freeze({...totals.email}),
        push:Object.freeze({...totals.push})
      }),
      backlog:Object.freeze({
        due:snapshot.due,
        expiredLeases:snapshot.expired_leases,
        oldestDueSeconds:snapshot.oldest_due_seconds??0
      }),
      last24Hours:Object.freeze({
        acceptedByProviders:snapshot.last_day_delivered,
        failedAttempts:snapshot.last_day_failed
      }),
      inbox:Object.freeze({
        stored:inbox.rows[0]?.stored??0,
        unread:inbox.rows[0]?.unread??0,
        hidden:inbox.rows[0]?.hidden??0
      }),
      deliverySemantics:'provider_accepted_not_device_receipt'
    });
  },true);
}
