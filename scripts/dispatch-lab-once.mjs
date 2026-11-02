/**
 * Manual ONE-tick runner. No cron installed, no Render deployment, no secrets printed.
 * Uses ONLY the disposable local PostgreSQL LAB database.
 * Example:
 *   CORE_V2_RUNTIME=isolated-lab CORE_V2_WRITES_ENABLED=true \
 *   CORE_V2_DATABASE_URL='postgresql://...@127.0.0.1:5432/tala_core_v2_lab' \
 *   node --experimental-strip-types scripts/dispatch-lab-once.mjs
 */
import {Pool} from 'pg';
import {dispatchNext} from '../src/modules/logistics/tala-dispatch-engine.ts';
const url=process.env.CORE_V2_DATABASE_URL;
let parsed;
try{parsed=new URL(url??'')}catch{throw Error('DISPATCH_LAB_DATABASE_INVALID')}
if(process.env.CORE_V2_RUNTIME!=='isolated-lab'||
   process.env.CORE_V2_WRITES_ENABLED!=='true'||
   process.env.NODE_ENV==='production'||
   !['postgres:','postgresql:'].includes(parsed.protocol)||
   !['127.0.0.1','localhost'].includes(parsed.hostname)||
   !['tala_core_v2_lab','tala_core_v2_test'].includes(parsed.pathname.slice(1))||
   parsed.search||parsed.hash){
  throw Error('DISPATCH_LAB_ONLY');
}
const pool=new Pool({connectionString:url,max:4,connectionTimeoutMillis:2000});
try{
  const check=await pool.query("SELECT current_database() AS db, to_regclass('tala_core_v2.dispatch_offers') IS NOT NULL AS ready");
  if(check.rows[0]?.db!==parsed.pathname.slice(1)||!check.rows[0]?.ready)
    throw Error('DISPATCH_LAB_SCHEMA_NOT_READY');
  const result=await dispatchNext(pool);
  console.log(JSON.stringify({module:'tala-dispatch-engine',scope:'isolated-lab',
    commercialReady:false,...result}));
}finally{await pool.end()}
