/**
 * Post-deploy Orders audit. No SQL writes; refuses non-read-only credentials.
 * Environment: CORE_V2_AUDIT_DATABASE_URL and optional ORDER_AUDIT_MAX_ORDERS.
 * Never outputs database credentials, buyer identities, addresses or order IDs.
 */
import {Pool} from 'pg';
import {auditOrdersReadOnly} from '../src/modules/orders/orders-audit.ts';

const uri=process.env.CORE_V2_AUDIT_DATABASE_URL;
if(!uri)throw Error('ORDERS_AUDIT_READONLY_URL_REQUIRED');
const url=new URL(uri);
if(!['postgresql:','postgres:'].includes(url.protocol)||
  !url.hostname||url.hash)throw Error('ORDERS_AUDIT_DATABASE_URL_INVALID');
const max=Number(process.env.ORDER_AUDIT_MAX_ORDERS??'10000');
const orderId=process.env.ORDER_AUDIT_ORDER_ID;
const pool=new Pool({
  connectionString:uri,max:1,connectionTimeoutMillis:3000,
  query_timeout:15000
});
try{
  const r=await pool.query<{
    superuser:boolean;can_write:boolean;can_read:boolean
  }>(`
    SELECT
      (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user)
        AS superuser,
      (
        has_table_privilege(current_user,'tala_core_v2.orders','INSERT,UPDATE,DELETE')
        OR has_table_privilege(current_user,'tala_core_v2.order_lines','INSERT,UPDATE,DELETE')
        OR has_table_privilege(current_user,'tala_core_v2.order_events','INSERT,UPDATE,DELETE')
        OR has_table_privilege(current_user,'tala_core_v2.outbox','INSERT,UPDATE,DELETE')
        OR has_table_privilege(current_user,'tala_core_v2.order_handoffs','INSERT,UPDATE,DELETE')
      ) AS can_write,
      has_table_privilege(current_user,'tala_core_v2.orders','SELECT')
        AS can_read`);
  const access=r.rows[0];
  if(!access||access.superuser||access.can_write||!access.can_read)
    throw Error('ORDERS_AUDIT_REQUIRES_SELECT_ONLY_ROLE');
  const audit=await auditOrdersReadOnly(pool,{
    maxOrders:max,orderId
  });
  console.log(JSON.stringify({module:'orders',mode:'read-only',...audit}));
  if(audit.status!=='PASS')process.exitCode=2;
}finally{
  await pool.end();
}
