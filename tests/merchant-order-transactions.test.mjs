import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {
  advanceMerchantOrder,merchantEventKey,MerchantOrderError
} from '../src/modules/orders/merchant-orders.ts';

const pgUrl=process.env.PG_CI_URL ?? '';
// These tests create persistent fixtures; allow ONLY the disposable CI database.
const enabled=pgUrl.includes('/tala_core_v2_test');
const key=()=> 'cmd-'+randomUUID();
const fixedHash='b'.repeat(64);
const rejectCode=(code)=>(e)=>e instanceof MerchantOrderError && e.code===code;

async function fixture(pool,{paymentMethod='cash',paymentStatus='pending',
  status='received',active=true}={}){
  const buyer=randomUUID(),restaurant=randomUUID(),actor=randomUUID(),id=randomUUID();
  await pool.query(`
    INSERT INTO tala_core_v2.orders
      (id,buyer_id,restaurant_id,fulfillment,status,payment_method,payment_status,
       total_minor,pricing_policy_version,price_snapshot,idempotency_key,request_hash)
    VALUES ($1::uuid,$2::uuid,$3::uuid,'delivery',$4,$5,$6,
      10000,'pilot-2026-11-v2-17pct','{"currency":"MXN"}'::jsonb,$7,$8)`,
    [id,buyer,restaurant,status,paymentMethod,paymentStatus,key(),fixedHash]);
  await pool.query(`
    INSERT INTO tala_core_v2.restaurant_memberships(restaurant_id,member_id,is_active)
    VALUES ($1::uuid,$2::uuid,$3)`,[restaurant,actor,active]);
  return {orderId:id,actorId:actor,commandKey:key(),expectedVersion:1n,target:'confirmed'};
}

test('CORE v2 merchant transaction updates state, evidence and outbox atomically',{
  skip:!enabled
},async()=>{
  const pool=new Pool({connectionString:pgUrl,max:3});
  try{
    const input=await fixture(pool);
    const result=await advanceMerchantOrder(pool,input);
    assert.deepEqual(result,{orderId:input.orderId,status:'confirmed',version:2n,replayed:false});
    const records=await pool.query(`
      SELECT o.status,o.version,
        (SELECT count(*)::int FROM tala_core_v2.order_events e WHERE e.order_id=o.id) events,
        (SELECT count(*)::int FROM tala_core_v2.outbox b WHERE b.aggregate_id=o.id) outbox_count
      FROM tala_core_v2.orders o WHERE o.id=$1::uuid`,[input.orderId]);
    assert.deepEqual(records.rows[0],{
      status:'confirmed',version:'2',events:1,outbox_count:1
    });
    const again=await advanceMerchantOrder(pool,input);
    assert.equal(again.replayed,true);
    assert.equal(again.status,'confirmed');
    assert.equal(again.version,2n);
    await assert.rejects(advanceMerchantOrder(pool,{...input,target:'preparing'}),rejectCode('IDEMPOTENCY_CONFLICT'));
    const counts=await pool.query(
      'SELECT count(*)::int AS events FROM tala_core_v2.order_events WHERE order_id=$1',[input.orderId]
    );
    assert.equal(counts.rows[0].events,1);
  }finally{await pool.end();}
});

test('CORE v2 retry of confirmed preserves original version after preparing',{
  skip:!enabled
},async()=>{
  const pool=new Pool({connectionString:pgUrl,max:2});
  try{
    const confirmed=await fixture(pool);
    const first=await advanceMerchantOrder(pool,confirmed);
    assert.equal(first.version,2n);
    const preparing=await advanceMerchantOrder(pool,{
      ...confirmed,target:'preparing',expectedVersion:2n,commandKey:key()
    });
    assert.equal(preparing.status,'preparing');
    assert.equal(preparing.version,3n);
    const replay=await advanceMerchantOrder(pool,confirmed);
    assert.deepEqual(replay,{
      orderId:confirmed.orderId,status:'confirmed',version:2n,replayed:true
    });
    const current=await pool.query(
      'SELECT status,version FROM tala_core_v2.orders WHERE id=$1::uuid',
      [confirmed.orderId]
    );
    assert.equal(current.rows[0].status,'preparing');
    assert.equal(current.rows[0].version,'3');
  }finally{await pool.end();}
});

test('CORE v2 rejects unauthorized, inactive and stale merchant commands',{
  skip:!enabled
},async()=>{
  const pool=new Pool({connectionString:pgUrl,max:2});
  try{
    const input=await fixture(pool);
    await assert.rejects(
      advanceMerchantOrder(pool,{...input,actorId:randomUUID()}),
      rejectCode('ORDER_NOT_FOUND_OR_FORBIDDEN')
    );
    const inactive=await fixture(pool,{active:false});
    await assert.rejects(
      advanceMerchantOrder(pool,inactive),
      rejectCode('ORDER_NOT_FOUND_OR_FORBIDDEN')
    );
    await assert.rejects(
      advanceMerchantOrder(pool,{...input,expectedVersion:2n}),
      rejectCode('ORDER_VERSION_CONFLICT')
    );
    await assert.rejects(
      advanceMerchantOrder(pool,{...input,target:'ready'}),
      rejectCode('TRANSITION_FORBIDDEN')
    );
  }finally{await pool.end();}
});

test('CORE v2 never accepts an unverified Stripe order or failed cash settlement',{
  skip:!enabled
},async()=>{
  const pool=new Pool({connectionString:pgUrl,max:2});
  try{
    const stripe=await fixture(pool,{paymentMethod:'stripe',paymentStatus:'pending'});
    await assert.rejects(advanceMerchantOrder(pool,stripe),rejectCode('PAYMENT_NOT_VERIFIED'));
    const failedCash=await fixture(pool,{paymentMethod:'cash',paymentStatus:'failed'});
    await assert.rejects(advanceMerchantOrder(pool,failedCash),rejectCode('PAYMENT_NOT_ALLOWED'));
    const paid=await fixture(pool,{paymentMethod:'stripe',paymentStatus:'paid'});
    const result=await advanceMerchantOrder(pool,paid);
    assert.equal(result.status,'confirmed');
  }finally{await pool.end();}
});

test('CORE v2 concurrent actions only commit one state/event',{
  skip:!enabled
},async()=>{
  const pool=new Pool({connectionString:pgUrl,max:4});
  try{
    const input=await fixture(pool);
    const result=await Promise.allSettled([
      advanceMerchantOrder(pool,input),
      advanceMerchantOrder(pool,{...input,commandKey:key()})
    ]);
    const successes=result.filter(r=>r.status==='fulfilled');
    const failures=result.filter(r=>r.status==='rejected');
    assert.equal(successes.length,1);
    assert.equal(failures.length,1);
    assert.equal(failures[0].reason.code,'ORDER_VERSION_CONFLICT');
    const summary=await pool.query(`
      SELECT (SELECT version FROM tala_core_v2.orders WHERE id=$1::uuid) version,
       (SELECT count(*)::int FROM tala_core_v2.order_events WHERE order_id=$1::uuid) events,
       (SELECT count(*)::int FROM tala_core_v2.outbox WHERE aggregate_id=$1::uuid) outbox_count`,
       [input.orderId]);
    assert.deepEqual(summary.rows[0],{version:'2',events:1,outbox_count:1});
  }finally{await pool.end();}
});

test('CORE v2 outbox insert failure rolls back order AND evidence',{
  skip:!enabled
},async()=>{
  const pool=new Pool({connectionString:pgUrl,max:2});
  try{
    const input=await fixture(pool);
    const eventKey=merchantEventKey(input);
    await pool.query(`
      INSERT INTO tala_core_v2.outbox(aggregate_id,event_key,event_type,payload)
      VALUES ($1::uuid,$2,'test.reserved','{}'::jsonb)`,[input.orderId,eventKey]);
    await assert.rejects(advanceMerchantOrder(pool,input),
      error=>error.code==='23505');
    const result=await pool.query(`
      SELECT o.status,o.version,
        (SELECT count(*)::int FROM tala_core_v2.order_events e WHERE e.order_id=o.id) events
      FROM tala_core_v2.orders o WHERE o.id=$1::uuid`,[input.orderId]);
    assert.deepEqual(result.rows[0],{status:'received',version:'1',events:0});
  }finally{await pool.end();}
});
