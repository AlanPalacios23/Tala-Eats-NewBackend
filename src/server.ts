/**
 * Read-only boot shell for the new isolated backend.
 * Deliberately contains NO checkout, order write, payment or payout routes.
 */
import express from 'express';
import { Pool } from 'pg';

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'16kb'}));
app.get('/health', (_req, res) => res.json({
  service:'tala-eats-core-v2',version:'0.1.0',status:'ok',
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
      "SELECT to_regclass('tala_core_v2.orders') IS NOT NULL AS orders_ready"
    );
    const schemaReady = result.rows[0]?.orders_ready === true;
    res.status(schemaReady?200:503).json({
      ready:schemaReady,
      database:schemaReady?'ok':'SCHEMA_MISSING',
      commercialReady:false
    });
  } catch {
    res.status(503).json({ready:false,database:'unavailable',commercialReady:false});
  }
});

if (process.env.CORE_V2_WRITES_ENABLED !== 'false') {
  throw Error('CORE_V2_WRITES_MUST_REMAIN_DISABLED');
}
const port = Number(process.env.CORE_V2_PORT ?? '18210');
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw Error('PORT_INVALID');
}
const host = process.env.CORE_V2_HOST ?? '127.0.0.1';
if (host !== '127.0.0.1') throw Error('LOCALHOST_ONLY_UNTIL_GATE_APPROVED');
app.listen(port,host,() => console.log('TALA_EATS_CORE_V2_READONLY_READY',port));
