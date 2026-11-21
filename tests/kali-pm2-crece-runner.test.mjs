import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const script=readFileSync('deploy/kali-core-v2-pm2-stage.sh','utf8');
test('Kali Crece staging uses the SAME checkout and PM2, never Docker or LIVE',()=>{
 assert.match(script,/RELEASE_BRANCH="release\/core-v2-rc5-pm2-single-stage"/);
 assert.match(script,/CRECE_BRANCH="feat\/core-v2-crece-fundadores-lab-20261108"/);
 assert.match(script,/\$RELEASE_BRANCH"\|"\$CRECE_BRANCH/);
 assert.match(script,/STAGE_PM2_HOME="\$HOME\/\.pm2-tala-core-v2-stage"/);
 assert.match(script,/PG_PORT=18432/);
 assert.match(script,/\-c listen_addresses=127\.0\.0\.1/);
 assert.match(script,/CORE_V2_INTEGRATION_PUBLIC_HTTP_ENABLED=false/);
 assert.doesNotMatch(script,/docker[ \t]+(?:run|start|stop|exec|compose|rm)/);
 assert.doesNotMatch(script,/pm2 (?:delete all|restart all|kill)/);
});
test('temporary core M1 database exists before root migrations, lab is removed',()=>{
 const make=script.indexOf('"CREATE DATABASE tala_core_v2_test"');
 const migrations=script.indexOf('for sql in "$ROOT/migrations/"*.sql;');
 assert.ok(make>0&&migrations>make);
 assert.match(script,/trap cleanup_lab EXIT/);
 assert.match(script,/RC5_TEMP_POSTGRES_CLUSTER_CLEANED=TRUE/);
 assert.match(script,/RC5_LIVE_RELEASE=NO_GO/);
});
