import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';

const url=process.env.PG_CI_URL??'';
test('P0 order snapshots, lines, SKU references and handoff amount are immutable in PostgreSQL',{
  skip:!url.includes('/tala_core_v2_test'),timeout:15000
},async()=>{
  const pool=new Pool({connectionString:url,max:1});
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const store=randomUUID(),product=randomUUID(),buyer=randomUUID();
    await db.query(`INSERT INTO tala_core_v2.restaurants(id,name,is_open)
      VALUES($1::uuid,'Auditoria QA',true)`,[store]);
    await db.query(`INSERT INTO tala_core_v2.catalog_products(id,restaurant_id,name,price_minor,stock)
      VALUES($1::uuid,$2::uuid,'Producto auditado',3000,10)`,[product,store]);
    const o=await db.query(`INSERT INTO tala_core_v2.orders
      (buyer_id,restaurant_id,fulfillment,status,payment_method,payment_status,
       total_minor,pricing_policy_version,price_snapshot,idempotency_key,request_hash)
      VALUES($1::uuid,$2::uuid,'pickup','received','cash','pending',3210,'qa-v1',
        '{"currency":"MXN"}'::jsonb,$3,$4) RETURNING id`,
      [buyer,store,'qa-'+randomUUID(),'a'.repeat(64)]);
    const id=o.rows[0].id;
    await db.query(`INSERT INTO tala_core_v2.order_lines
      (order_id,line_number,product_id,product_name_snapshot,unit_minor,quantity)
      VALUES($1::uuid,1,$2::uuid,'Producto auditado',3000,1)`,[id,product]);
    await db.query(`INSERT INTO tala_core_v2.order_handoffs(order_id,cash_amount_minor)
      VALUES($1::uuid,3210)`,[id]);
    const reject=async(label,query,args,check)=>{
      await db.query('SAVEPOINT '+label);
      await assert.rejects(db.query(query,args),error=>
        error.code===check.code&&(!check.message||error.message.includes(check.message)));
      await db.query('ROLLBACK TO SAVEPOINT '+label);
    };
    await reject('immutable_line_update',`UPDATE tala_core_v2.order_lines
      SET unit_minor=1 WHERE order_id=$1`,[id],
      {code:'23514',message:'ORDER_LINE_SNAPSHOT_IMMUTABLE'});
    await reject('immutable_line_delete',`DELETE FROM tala_core_v2.order_lines
      WHERE order_id=$1`,[id],
      {code:'23514',message:'ORDER_LINE_SNAPSHOT_IMMUTABLE'});
    await reject('immutable_price',`UPDATE tala_core_v2.orders
      SET total_minor=10000 WHERE id=$1`,[id],
      {code:'23514',message:'ORDER_SNAPSHOT_IMMUTABLE'});
    await reject('immutable_buyer',`UPDATE tala_core_v2.orders
      SET buyer_id=$2::uuid WHERE id=$1`,[id,randomUUID()],
      {code:'23514',message:'ORDER_SNAPSHOT_IMMUTABLE'});
    await reject('immutable_address',`UPDATE tala_core_v2.orders
      SET delivery_address='Calle distinta 567' WHERE id=$1`,[id],
      {code:'23514',message:'ORDER_SNAPSHOT_IMMUTABLE'});
    await reject('immutable_handoff',`UPDATE tala_core_v2.order_handoffs
      SET cash_amount_minor=1 WHERE order_id=$1`,[id],
      {code:'23514',message:'HANDOFF_AMOUNT_IMMUTABLE'});
    await db.query(`UPDATE tala_core_v2.order_handoffs
      SET buyer_cash_ack_at=now() WHERE order_id=$1`,[id]);
    await reject('immutable_cash_ack',`UPDATE tala_core_v2.order_handoffs
      SET buyer_cash_ack_at=NULL WHERE order_id=$1`,[id],
      {code:'23514',message:'ORDER_HANDOFF_PROOF_IMMUTABLE'});
    await db.query(`UPDATE tala_core_v2.order_handoffs
      SET pin_consumed_at=now() WHERE order_id=$1`,[id]);
    await reject('immutable_consumed_pin',`UPDATE tala_core_v2.order_handoffs
      SET pin_consumed_at=NULL WHERE order_id=$1`,[id],
      {code:'23514',message:'ORDER_HANDOFF_PROOF_IMMUTABLE'});
    await reject('catalog_fk',`DELETE FROM tala_core_v2.catalog_products
      WHERE id=$1::uuid`,[product],{code:'23503'});
    const progress=await db.query(`UPDATE tala_core_v2.orders
      SET status='confirmed',version=version+1 WHERE id=$1
      RETURNING status,version,total_minor`,[id]);
    assert.deepEqual(progress.rows[0],{status:'confirmed',version:'2',total_minor:'3210'});
  }finally{
    await db.query('ROLLBACK');
    db.release();
    await pool.end();
  }
});
