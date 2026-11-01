/** CORE v2: fail-closed boot shell. Order writes ONLY inside isolated LAB. */
import express from 'express';
import { Pool } from 'pg';
import {createOrderApp} from './modules/orders/lab-http.ts';

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'16kb'}));
app.get('/health', (_req, res) => res.json({
  service:'tala-eats-core-v2',version:'0.2.0-lab.1',status:'ok',
  commercialReady:false
}));

const databaseUrl = process.env.CORE_V2_DATABASE_URL?.trim();
const pool = databaseUrl
  ? new Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:2000})
  : null;

app.get('/ready', async (_req,res) => {
  if (!pool) {
    res.status(503).json({ready:false,reason:'ISOLATED_DATABASE_NOT_CONFIGURED'});
    return;
  }
  try {
    const result = await pool.query(
      `SELECT
        to_regclass('tala_core_v2.orders') IS NOT NULL AS orders_ready,
        to_regclass('tala_core_v2.accounts') IS NOT NULL AS accounts_ready,
        to_regclass('tala_core_v2.sessions') IS NOT NULL AS sessions_ready,
        to_regclass('tala_core_v2.restaurants') IS NOT NULL AS restaurants_ready,
        to_regclass('tala_core_v2.catalog_products') IS NOT NULL AS catalog_ready,
        to_regclass('tala_core_v2.restaurant_memberships') IS NOT NULL AS members_ready,
        to_regclass('tala_core_v2.order_handoffs') IS NOT NULL AS handoff_ready,
        to_regclass('tala_core_v2.driver_profiles') IS NOT NULL AS drivers_ready`
    );
    const schemaReady = result.rows[0]?.orders_ready === true &&
      (process.env.CORE_V2_WRITES_ENABLED!=='true'||
        ['accounts_ready','sessions_ready','restaurants_ready','catalog_ready','members_ready','handoff_ready','drivers_ready']
          .every(k=>result.rows[0]?.[k]===true));
    res.status(schemaReady?200:503).json({
      ready:schemaReady,
      database:schemaReady?'ok':'SCHEMA_MISSING',
      commercialReady:false
    });
  } catch {
    res.status(503).json({ready:false,database:'unavailable',commercialReady:false});
  }
});

// Fail closed. HTTP order writes are *only* permitted on loopback with
// a disposable, separately named lab database. Production remains read-only.
const writesFlag=process.env.CORE_V2_WRITES_ENABLED;
if (writesFlag!=='false' && writesFlag!=='true') {
  throw Error('CORE_V2_WRITES_MUST_REMAIN_DISABLED');
}
if (writesFlag==='true') {
  const url=databaseUrl?new URL(databaseUrl):null;
  const dbName=url?.pathname.slice(1);
  if(process.env.CORE_V2_RUNTIME!=='isolated-lab'||
    process.env.NODE_ENV==='production'||!pool||!url||
    !['postgres:','postgresql:'].includes(url.protocol)||
    url.search!==''||url.hash!==''||
    !['127.0.0.1','localhost'].includes(url.hostname)||
    !['tala_core_v2_lab','tala_core_v2_test'].includes(dbName??'')){
    throw Error('CORE_V2_WRITES_MUST_REMAIN_DISABLED');
  }
  // URL validation is insufficient by itself; inspect the ACTIVE DB before
  // listening. A missing schema must fail startup, not silently expose routes.
  try{
    const result=await pool.query(`SELECT current_database() AS db_name,
      to_regclass('tala_core_v2.orders') IS NOT NULL AS orders_ready,
      to_regclass('tala_core_v2.accounts') IS NOT NULL AS accounts_ready,
      to_regclass('tala_core_v2.sessions') IS NOT NULL AS sessions_ready,
      to_regclass('tala_core_v2.catalog_products') IS NOT NULL AS products_ready,
      to_regclass('tala_core_v2.restaurant_memberships') IS NOT NULL AS members_ready,
        to_regclass('tala_core_v2.order_handoffs') IS NOT NULL AS handoff_ready,
        to_regclass('tala_core_v2.driver_profiles') IS NOT NULL AS drivers_ready`);
    const row=result.rows[0];
    if(row?.db_name!==dbName||
      !['orders_ready','accounts_ready','sessions_ready','products_ready','members_ready','handoff_ready','drivers_ready'].every(k=>row?.[k]===true)){
      throw Error('LAB_SCHEMA_NOT_READY');
    }
  }catch{
    throw Error('CORE_V2_LAB_DATABASE_ADMISSION_FAILED');
  }
  app.use(createOrderApp(pool));
}
const port = Number(process.env.CORE_V2_PORT ?? '18210');
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw Error('PORT_INVALID');
}
const host = process.env.CORE_V2_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1') throw Error('LOCALHOST_ONLY_UNTIL_GATE_APPROVED');
app.listen(port,host,() => console.log(writesFlag==='true'?'TALA_EATS_CORE_V2_LAB_READY':'TALA_EATS_CORE_V2_READONLY_READY',port));
