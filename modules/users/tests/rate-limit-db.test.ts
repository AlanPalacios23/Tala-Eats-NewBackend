import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {UsersError} from '../src/domain.js';
import {consumeLabRequestQuota} from '../src/rate-limit.js';
import {cleanupLabExpiredIdentityData} from '../src/maintenance.js';

const url=process.env.USERS_CI_URL??'';
const enabled=/\/tala_users_v2_test(?:$|\?)/.test(url);
test('M4 durable rate limiter shares quota across two instances and retains no raw IP',
  {skip:!enabled,timeout:70000},async()=>{
  const a=new pg.Pool({connectionString:url,max:4});
  const b=new pg.Pool({connectionString:url,max:4});
  try{
    const secret=randomBytes(32);
    const address='198.51.100.'+Math.floor(Math.random()*200);
    const path='/v1/users/private-'+randomUUID();
    const args={remoteAddress:address,method:'POST',route:path,secret,limit:2};
    await consumeLabRequestQuota(a,args);
    await consumeLabRequestQuota(b,args);
    await assert.rejects(
      ()=>consumeLabRequestQuota(a,args),
      (e:unknown)=>e instanceof UsersError&&e.code==='USERS_RATE_LIMITED');
    const rows=await b.query('SELECT subject_hash,requests FROM tala_users_v2.request_rate_buckets WHERE requests>=3');
    assert.ok(rows.rows.some(r=>r.requests>=3));
    assert.equal(JSON.stringify(rows.rows).includes(address),false);
    assert.equal(JSON.stringify(rows.rows).includes(path),false);
    await consumeLabRequestQuota(b,{...args,method:'GET'});
    await consumeLabRequestQuota(b,{...args,secret:randomBytes(32)});
    const old=await a.query(
      "UPDATE tala_users_v2.request_rate_buckets "+
      "SET window_started_at=clock_timestamp()-interval '3 days' "+
      "WHERE requests=3 RETURNING subject_hash");
    assert.ok((old.rowCount??0)>=1);
    const cleaned=await cleanupLabExpiredIdentityData(a);
    assert.ok(cleaned.staleRateBucketsDeleted>=1);
  }finally{await a.end();await b.end();}
});
