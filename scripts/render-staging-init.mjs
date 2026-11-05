/**
 * One-time, migration-ledger backed bootstrap for the EXISTING disposable
 * Render Free database only. Runs before the read-only staging server.
 * Never exposes the Orders HTTP API and never connects to Kali/LIVE.
 * All seven source migrations are run in their existing PostgreSQL transactions.
 */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';

const fail=(code)=>{throw Error(code)};
if(process.env.RENDER!=='true' ||
   process.env.RENDER_SERVICE_ID!=='srv-dbjqks0473hc73akv7og' ||
   process.env.RENDER_SERVICE_NAME!=='tala-eats-core-staging' ||
   process.env.RENDER_GIT_BRANCH!=='feat/core-v2-pedidos-foundation' ||
   process.env.CORE_V2_RUNTIME!=='render-staging' ||
   process.env.CORE_V2_WRITES_ENABLED!=='false' ||
   process.env.NODE_ENV!=='production' ||
   process.env.CORE_V2_STAGING_MIGRATIONS!=='initial-001-007-only'){
  fail('ORDERS_STAGING_MIGRATION_ENVIRONMENT_DENIED');
}
const raw=process.env.CORE_V2_DATABASE_URL;
if(!raw)fail('ORDERS_STAGING_DATABASE_URL_MISSING');
let url;
try{url=new URL(raw)}catch{fail('ORDERS_STAGING_DATABASE_URL_INVALID')}
if(!['postgres:','postgresql:'].includes(url.protocol)||
   url.pathname!=='/tala_eats_core_staging_db'||
   url.username!=='tala_eats_core_staging_db_user'||
   !/^dpg-[a-z0-9-]+$/.test(url.hostname)||
   url.hash || url.search ||
   (url.port!=='' && url.port!=='5432')){
  fail('ORDERS_STAGING_DATABASE_IDENTITY_DENIED');
}

const files=[
 '001_orders.sql',
 '002_order_permissions.sql',
 '003_orders_http_lab.sql',
 '004_order_handoffs_lab.sql',
 '005_orders_integrity_lab.sql',
 '006_order_pin_rate_lab.sql',
 '007_orders_address_handoff_integrity_lab.sql'
];
const pool=new Pool({connectionString:raw,max:1,
  connectionTimeoutMillis:6000,statement_timeout:30000});
let client;
let locked=false;
try{
  client=await pool.connect();
  const verified=await client.query(`
    SELECT current_database() AS db,
      current_user AS username,
      current_setting('server_version_num')::integer AS pg_version,
      to_regclass('tala_core_v2.orders') IS NOT NULL AS orders_exist,
      to_regclass('tala_core_v2.schema_migrations') IS NOT NULL AS ledger_exists`);
  const row=verified.rows[0];
  if(row?.db!=='tala_eats_core_staging_db' ||
     row.username!=='tala_eats_core_staging_db_user' ||
     row.pg_version<150000)fail('ORDERS_STAGING_ACTIVE_DATABASE_DENIED');
  await client.query('SELECT pg_advisory_lock(2026,1101)');
  locked=true;
  // Re-check while holding the exclusive migration lock.
  const status=await client.query(`
    SELECT to_regclass('tala_core_v2.orders') IS NOT NULL AS orders_exist,
      to_regclass('tala_core_v2.schema_migrations') IS NOT NULL AS ledger_exists`);
  if(status.rows[0].orders_exist && !status.rows[0].ledger_exists)
    fail('ORDERS_STAGING_UNTRACKED_SCHEMA_DENIED');
  const done=new Map();
  if(status.rows[0].ledger_exists){
    const rs=await client.query(`
      SELECT name,checksum FROM tala_core_v2.schema_migrations ORDER BY name`);
    for(const r of rs.rows)done.set(r.name,r.checksum);
    if([...done.keys()].some(k=>!files.includes(k)))
      fail('ORDERS_STAGING_UNKNOWN_MIGRATION_DENIED');
  }
  let applied=0;
  for(const name of files){
    const source=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
    if(!/^BEGIN;/m.test(source)||!/COMMIT;\s*$/.test(source))
      fail('ORDERS_STAGING_MIGRATION_TRANSACTION_MISSING');
    const checksum=createHash('sha256').update(source).digest('hex');
    if(done.has(name)){
      if(done.get(name)!==checksum)
        fail('ORDERS_STAGING_MIGRATION_CHECKSUM_MISMATCH');
      continue;
    }
    // Stop on a gap: e.g. migration 002 missing while 003 is already applied.
    if([...files.slice(files.indexOf(name)+1)].some(k=>done.has(k)))
      fail('ORDERS_STAGING_MIGRATION_GAP_DENIED');
    // Attach schema ledger to the migration's own BEGIN/COMMIT, so it cannot
    // be recorded applied if a DDL statement fails.
    const safeName=name.replace(/'/g,"''");
    const extra=`
CREATE TABLE IF NOT EXISTS tala_core_v2.schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tala_core_v2.schema_migrations(name,checksum)
VALUES ('${safeName}','${checksum}');
COMMIT;`;
    const combined=source.replace(/COMMIT;\s*$/,extra);
    await client.query(combined);
    applied++;
  }
  const schema=await client.query(`
    SELECT
      to_regclass('tala_core_v2.orders') IS NOT NULL AS orders,
      to_regclass('tala_core_v2.order_handoffs') IS NOT NULL AS handoffs,
      to_regclass('tala_core_v2.accounts') IS NOT NULL AS accounts,
      EXISTS(SELECT 1 FROM pg_trigger
        WHERE tgrelid=to_regclass('tala_core_v2.orders')
          AND tgname='trg_order_snapshot_immutable' AND NOT tgisinternal)
        AS order_integrity,
      EXISTS(SELECT 1 FROM pg_trigger
        WHERE tgrelid=to_regclass('tala_core_v2.order_handoffs')
          AND tgname='trg_order_handoff_proof_immutable' AND NOT tgisinternal)
        AS handoff_integrity,
      (SELECT count(*)::integer FROM tala_core_v2.schema_migrations) AS migrations`);
  if(!schema.rows[0]?.orders||!schema.rows[0]?.handoffs||
     !schema.rows[0]?.accounts||!schema.rows[0]?.order_integrity||
     !schema.rows[0]?.handoff_integrity||schema.rows[0]?.migrations!==7)
    fail('ORDERS_STAGING_SCHEMA_ADMISSION_FAILED');
  console.log(JSON.stringify({
    service:'tala-eats-core-staging',phase:'staging-postgres',
    schema:'ready',migrations:7,newMigrations:applied,commercialReady:false
  }));
}catch(error){
  // Never reveal the URL, SQL exception details or credentials in public logs.
  console.error('ORDERS_STAGING_INIT_FAILED');
  process.exitCode=1;
}finally{
  if(client){
    if(locked){
      try{await client.query('SELECT pg_advisory_unlock(2026,1101)')}catch{}
    }
    client.release();
  }
  await pool.end();
}
