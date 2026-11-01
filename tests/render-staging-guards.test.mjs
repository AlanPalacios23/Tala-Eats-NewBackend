import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const script='scripts/render-staging-init.mjs';
const base={
  ...process.env,RENDER:'true',RENDER_SERVICE_ID:'srv-dbjqks0473hc73akv7og',
  RENDER_SERVICE_NAME:'tala-eats-core-staging',
  RENDER_GIT_BRANCH:'feat/core-v2-pedidos-foundation',
  CORE_V2_RUNTIME:'render-staging',
  CORE_V2_WRITES_ENABLED:'false',NODE_ENV:'production',
  CORE_V2_STAGING_MIGRATIONS:'initial-001-007-only'
};
const run=env=>spawnSync(process.execPath,[script],{
  env:{...base,...env},encoding:'utf8',timeout:5000
});

test('Render staging migrator refuses non-staging runtime before DB access',()=>{
  const r=run({CORE_V2_RUNTIME:'isolated-lab',
    CORE_V2_DATABASE_URL:'postgres://fake:fake@127.0.0.1/tala_node_live'});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/ORDERS_STAGING_MIGRATION_ENVIRONMENT_DENIED/);
});

test('Render staging migrator refuses production or loopback DB name/host',{
  timeout:8000
},()=>{
  for(const url of [
    'postgres://fake:fake@127.0.0.1/tala_eats_core_staging_db',
    'postgres://fake:fake@dpg-real-a/tala_node_live',
    'postgres://fake:fake@dpg-real-a/tala_eats_core_staging_db',
    'postgres://tala_eats_core_staging_db_user:fake@127.0.0.1/tala_eats_core_staging_db'
  ]){
    const r=run({CORE_V2_DATABASE_URL:url});
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/ORDERS_STAGING_DATABASE_IDENTITY_DENIED/);
  }
});

test('Render Blueprint requires existing Free resources and private DB reference',()=>{
  const yaml=readFileSync('render.yaml','utf8');
  for(const pattern of [
    /name:\s*tala-eats-core-staging\b/,
    /plan:\s*free/,
    /region:\s*oregon/,
    /autoDeployTrigger:\s*off/,
    /CORE_V2_WRITES_ENABLED\s*\n\s*value:\s*["']?false/,
    /CORE_V2_RUNTIME\s*\n\s*value:\s*render-staging/,
    /CORE_V2_DATABASE_URL\s*\n\s*fromDatabase:\s*\n\s*name:\s*tala-eats-core-staging-db\s*\n\s*property:\s*connectionString/,
    /startCommand:\s*node scripts\/render-staging-init\.mjs && npm start/
  ])assert.match(yaml,pattern);
  assert.doesNotMatch(yaml,/\ndatabases\s*:/,'must not create a new paid database');
  assert.doesNotMatch(yaml,/postgres:\/\/[^\s]+:[^\s]+@/,
    'must not hardcode DB secrets');
});
