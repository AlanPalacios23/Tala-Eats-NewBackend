import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';

const connectionString=process.env.PG_CI_URL;
const makeHash=()=> 'a'.repeat(64);

test('isolated schema enforces idempotency, immutable evidence and money constraints', {
  skip: !connectionString
}, async () => {
  const pool=new Pool({connectionString,max:1});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const buyer=randomUUID();
    const merchant=randomUUID();
    const key='request-'+randomUUID();
    const args=[buyer,merchant,key,makeHash()];
    const inserted=await client.query(
      `INSERT INTO tala_core_v2.orders
         (buyer_id,restaurant_id,fulfillment,payment_method,total_minor,
          pricing_policy_version,price_snapshot,idempotency_key,request_hash)
       VALUES ($1,$2,'pickup','cash',10000,'pilot-2026-11-v2-17pct',
               '{"currency":"MXN"}'::jsonb,$3,$4)
       RETURNING id`,
      args
    );
    assert.equal(inserted.rowCount,1);
    const orderId=inserted.rows[0].id;

    await client.query('SAVEPOINT duplicate_check');
    await assert.rejects(
      client.query(
        `INSERT INTO tala_core_v2.orders
          (buyer_id,restaurant_id,fulfillment,payment_method,total_minor,
           pricing_policy_version,price_snapshot,idempotency_key,request_hash)
        VALUES ($1,$2,'pickup','cash',10000,'pilot-2026-11-v2-17pct',
                '{"currency":"MXN"}'::jsonb,$3,$4)`,
        args
      ),
      err => err.code === '23505'
    );
    await client.query('ROLLBACK TO SAVEPOINT duplicate_check');

    const eventKey='event-'+randomUUID();
    await client.query(
      `INSERT INTO tala_core_v2.order_events
        (order_id,event_key,previous_status,new_status,actor_role,actor_id)
       VALUES ($1,$2,NULL,'awaiting_payment','system',NULL)`,
      [orderId,eventKey]
    );
    await client.query('SAVEPOINT immutable_check');
    await assert.rejects(
      client.query(
        'DELETE FROM tala_core_v2.order_events WHERE order_id=$1',[orderId]
      ),
      err => err.message.includes('ORDER_EVENT_APPEND_ONLY')
    );
    await client.query('ROLLBACK TO SAVEPOINT immutable_check');

    await client.query('SAVEPOINT invalid_money_check');
    await assert.rejects(
      client.query('UPDATE tala_core_v2.orders SET total_minor=-1 WHERE id=$1',[orderId]),
      err => err.code === '23514'
    );
    await client.query('ROLLBACK TO SAVEPOINT invalid_money_check');

    const row=await client.query(
      'SELECT status,total_minor FROM tala_core_v2.orders WHERE id=$1',[orderId]
    );
    assert.equal(row.rows[0].status,'awaiting_payment');
    assert.equal(row.rows[0].total_minor,'10000');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
