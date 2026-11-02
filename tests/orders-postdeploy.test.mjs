import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {auditOrdersReadOnly} from '../src/modules/modulo-1-pedidos/orders-audit.ts';

const db=process.env.PG_CI_URL??'';
const enabled=db.includes('/tala_core_v2_test');
const signed=()=>createHash('sha256').update(randomUUID()).digest('hex');

async function seed(pool,broken=false){
  const buyer=randomUUID(),store=randomUUID(),product=randomUUID();
  await pool.query(`INSERT INTO tala_core_v2.restaurants(id,name,is_open)
    VALUES($1::uuid,'Audit QA Store',true)`,[store]);
  await pool.query(`INSERT INTO tala_core_v2.catalog_products(id,restaurant_id,name,price_minor,stock)
    VALUES($1::uuid,$2::uuid,'Audit QA Item',10000,5)`,[product,store]);
  const created=await pool.query(`
    INSERT INTO tala_core_v2.orders(
      buyer_id,restaurant_id,fulfillment,status,payment_method,payment_status,
      total_minor,pricing_policy_version,price_snapshot,idempotency_key,request_hash)
    VALUES($1::uuid,$2::uuid,$3,$4,'cash','pending',10700,'audit-lab',
      $5::jsonb,$6,$7) RETURNING id`,[
      buyer,store,broken?'delivery':'pickup',broken?'delivered':'received',
      JSON.stringify(broken?{}:{
        itemsMinor:'10000',serviceFeeMinor:'700',deliveryFeeMinor:'0',
        tipMinor:'0',totalMinor:'10700'
      }), 'audit-'+randomUUID(),signed()
    ]);
  const orderId=created.rows[0].id;
  if(!broken){
    await pool.query(`
      INSERT INTO tala_core_v2.order_lines(
        order_id,line_number,product_id,product_name_snapshot,unit_minor,quantity)
      VALUES($1::uuid,1,$2::uuid,'Audit QA Item',10000,1)`,[orderId,product]);
    const e=signed();
    await pool.query(`
      INSERT INTO tala_core_v2.order_events(
        order_id,event_key,previous_status,new_status,actor_role,actor_id,data)
      VALUES($1::uuid,$2,NULL,'received','system',NULL,'{}'::jsonb)`,[orderId,e]);
    await pool.query(`
      INSERT INTO tala_core_v2.outbox(aggregate_id,event_key,event_type,payload)
      VALUES($1::uuid,$2,'order.created',$3::jsonb)`,
      [orderId,e,JSON.stringify({orderId,status:'received'})]);
  }
  return orderId;
}

test('P0 postdeploy: consistent order passes an isolated read-only audit',{
  skip:!enabled,timeout:20000
},async()=>{
  const pool=new Pool({connectionString:db,max:2});
  try{
    const id=await seed(pool);
    const result=await auditOrdersReadOnly(pool,{orderId:id,pageSize:1,maxOrders:1});
    assert.equal(result.status,'PASS');
    assert.equal(result.scanned,1);
    assert.equal(result.hasMore,false);
    assert.deepEqual(result.counters,{
      scanned:1,missingLines:0,invalidTotals:0,versionDrift:0,
      missingOutbox:0,missingAssignment:0,missingDeliveryProof:0
    });
    assert.equal('orderId' in result,false);
    assert.equal(JSON.stringify(result).includes(id),false);
    const nonexistent=await auditOrdersReadOnly(pool,{
      orderId:randomUUID(),maxOrders:1
    });
    assert.equal(nonexistent.status,'INCOMPLETE',
      'An empty selection cannot prove post-deploy health');
    assert.equal(nonexistent.scanned,0);
  }finally{await pool.end();}
});

test('P0 postdeploy: broken delivery with no evidence cannot look healthy',{
  skip:!enabled,timeout:20000
},async()=>{
  const pool=new Pool({connectionString:db,max:2});
  try{
    const id=await seed(pool,true);
    const result=await auditOrdersReadOnly(pool,{orderId:id,maxOrders:1});
    assert.equal(result.status,'FAIL');
    assert.equal(result.scanned,1);
    assert.equal(result.counters.missingLines,1);
    assert.equal(result.counters.invalidTotals,1);
    assert.equal(result.counters.versionDrift,1);
    assert.equal(result.counters.missingAssignment,1);
    assert.equal(result.counters.missingDeliveryProof,1);
    assert.equal(result.counters.missingOutbox,0);
    const e=signed();
    await pool.query(`
      INSERT INTO tala_core_v2.order_events(
        order_id,event_key,previous_status,new_status,actor_role,data)
      VALUES($1::uuid,$2,NULL,'received','system','{}'::jsonb)`,[id,e]);
    const missing=await auditOrdersReadOnly(pool,{orderId:id,maxOrders:1});
    assert.equal(missing.counters.missingOutbox,1);
  }finally{await pool.end();}
});

test('P0 postdeploy: maxOrders must never return green for a partial scan',{
  skip:!enabled,timeout:20000
},async()=>{
  const pool=new Pool({connectionString:db,max:2});
  try{
    const a=await seed(pool),b=await seed(pool);
    assert.notEqual(a,b);
    const result=await auditOrdersReadOnly(pool,{maxOrders:1,pageSize:1});
    assert.equal(result.scanned,1);
    assert.equal(result.hasMore,true);
    assert.equal(result.status,'INCOMPLETE');
    await assert.rejects(
      auditOrdersReadOnly(pool,{maxOrders:0}),/ORDERS_AUDIT_OPTIONS_INVALID/);
    await assert.rejects(
      auditOrdersReadOnly(pool,{orderId:'unsafe-id'}),/ORDERS_AUDIT_OPTIONS_INVALID/);
  }finally{await pool.end();}
});
