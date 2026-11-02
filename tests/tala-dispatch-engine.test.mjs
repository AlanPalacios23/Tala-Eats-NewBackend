import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createOrderApp} from '../src/modules/orders/lab-http.ts';
import {hashPassword} from '../src/modules/orders/lab-auth.ts';
import {dispatchNext,expireDispatchOffers,recoverUncollectedAssignment}
  from '../src/modules/logistics/tala-dispatch-engine.ts';

const db=process.env.PG_CI_URL||'';
const enabled=db.includes('/tala_core_v2_test');
const key=()=> 'cmd-'+randomUUID();
const pass='Tala-Dispatch-Lab-2026!';
test('TALA DISPATCH LAB2: exclusive offers, acceptance, expiry, safe recovery and privacy',
  {skip:!enabled,timeout:70000},async()=>{
  const pool=new Pool({connectionString:db,max:12});
  const server=createOrderApp(pool).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const request=async(method,path,body,cookie)=>{
    const res=await fetch(base+path,{method,headers:{
      ...(body!==undefined?{'Content-Type':'application/json'}:{}),
      ...(method!=='GET'?{'X-Talaeats-Client':'core-v2-lab'}:{}),
      ...(cookie?{Cookie:cookie}:{})
    },body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,data:await res.json(),
      cookie:res.headers.get('set-cookie')?.split(';')[0]};
  };
  try{
    const store=randomUUID(),item=randomUUID();
    await pool.query("INSERT INTO tala_core_v2.restaurants(id,name,is_open) VALUES($1,'Tala Cocina LAB',true)",[store]);
    await pool.query("INSERT INTO tala_core_v2.catalog_products(id,restaurant_id,name,price_minor,stock) VALUES($1,$2,'Producto',9900,10)",[item,store]);
    const seed=async(role)=>{
      const id=randomUUID(),email=role+randomUUID()+'@example.test';
      await pool.query("INSERT INTO tala_core_v2.accounts(id,email,display_name,password_hash,role) VALUES($1,$2,'Tala Test User',$3,$4)",
        [id,email,await hashPassword(pass),role]);
      if(role==='merchant')await pool.query(
        'INSERT INTO tala_core_v2.restaurant_memberships(restaurant_id,member_id,is_active) VALUES($1,$2,true)',[store,id]);
      if(role==='driver')await pool.query(
        'INSERT INTO tala_core_v2.driver_profiles(account_id,approved,is_online) VALUES($1,true,true)',[id]);
      const login=await request('POST','/api/v2/auth/login',{email,password:pass});
      assert.equal(login.status,200,JSON.stringify(login.data));
      return {id,cookie:login.cookie};
    };
    const buyer=await seed('customer'),merchant=await seed('merchant');
    const drivers=[await seed('driver'),await seed('driver')];
    const makeOrder=async()=>{
      const created=await request('POST','/api/v2/orders',{
        restaurantId:store,fulfillment:'delivery',paymentMethod:'cash',
        deliveryAddress:'Privada de Comprador 101, Tala',
        lines:[{productId:item,quantity:1}],idempotencyKey:key()
      },buyer.cookie);
      assert.equal(created.status,201,JSON.stringify(created.data));
      const id=created.data.order.id;
      let version='1';
      for(const status of ['confirmed','preparing','ready']){
        const r=await request('PATCH','/api/v2/merchant/orders/'+id+'/status',
          {status,expectedVersion:version,commandKey:key()},merchant.cookie);
        assert.equal(r.status,200,JSON.stringify(r.data));
        version=r.data.version;
      }
      return {id,version};
    };
    const orders=[await makeOrder(),await makeOrder()];
    const [one,two]=await Promise.all([dispatchNext(pool),dispatchNext(pool)]);
    assert.equal(one.state,'offered');assert.equal(two.state,'offered');
    assert.notEqual(one.orderId,two.orderId,'one offer per order');
    assert.notEqual(one.driverId,two.driverId,'one pending offer per driver');
    const assigned=one,waiting=two;
    const driver=drivers.find(x=>x.id===assigned.driverId);
    const other=drivers.find(x=>x.id===waiting.driverId);
    assert.ok(driver);assert.ok(other);
    const badBuyer=await request('GET','/api/v2/driver/dispatch-offers',undefined,buyer.cookie);
    assert.equal(badBuyer.status,403);
    const wrong=await request('POST',
      '/api/v2/driver/dispatch-offers/'+assigned.offerId+'/accept',{},other.cookie);
    assert.equal(wrong.status,404,'no foreign offer access');
    const list=await request('GET','/api/v2/driver/dispatch-offers',undefined,driver.cookie);
    assert.equal(list.status,200);
    assert.equal(list.data.length,1);
    assert.equal(list.data[0].offerId,assigned.offerId);
    assert.equal(JSON.stringify(list.data).includes('Privada de Comprador'),false);
    assert.equal(JSON.stringify(list.data).includes('buyer'),false);
    const directClaim=await request('POST','/api/v2/driver/orders/'+assigned.orderId+'/claim',
      {expectedVersion:'4',commandKey:key()},other.cookie);
    assert.equal(directClaim.status,409,JSON.stringify(directClaim.data));
    assert.equal(directClaim.data.code,'DISPATCH_OFFER_PENDING');

    const accepted=await request('POST',
      '/api/v2/driver/dispatch-offers/'+assigned.offerId+'/accept',{},driver.cookie);
    assert.equal(accepted.status,200,JSON.stringify(accepted.data));
    assert.equal(accepted.data.version,'5');
    assert.equal(accepted.data.replayed,false);
    const replay=await request('POST',
      '/api/v2/driver/dispatch-offers/'+assigned.offerId+'/accept',{},driver.cookie);
    assert.equal(replay.status,200);
    assert.equal(replay.data.replayed,true);
    const mine=await request('GET','/api/v2/driver/orders',undefined,driver.cookie);
    assert.equal(mine.data.some(x=>x.id===assigned.orderId&&x.delivery_address.includes('Comprador')),true);

    const decline=await request('POST',
      '/api/v2/driver/dispatch-offers/'+waiting.offerId+'/decline',{},other.cookie);
    assert.equal(decline.status,200,JSON.stringify(decline.data));
    const declineAgain=await request('POST',
      '/api/v2/driver/dispatch-offers/'+waiting.offerId+'/decline',{},other.cookie);
    assert.equal(declineAgain.status,200);assert.equal(declineAgain.data.replayed,true);
    assert.equal((await pool.query(
      'SELECT status FROM tala_core_v2.orders WHERE id=$1',[waiting.orderId])).rows[0].status,'ready');
    const third=await seed('driver');
    const next=await dispatchNext(pool);
    assert.equal(next.state,'offered',JSON.stringify(next));
    assert.equal(next.orderId,waiting.orderId);
    assert.equal(next.driverId,third.id);
    await pool.query("UPDATE tala_core_v2.dispatch_offers SET created_at=now()-interval '120 seconds', expires_at=now()-interval '60 seconds' WHERE id=$1",[next.offerId]);
    assert.equal(await expireDispatchOffers(pool),1);
    const stale=await request('POST',
      '/api/v2/driver/dispatch-offers/'+next.offerId+'/accept',{},third.cookie);
    assert.equal(stale.status,409);
    assert.equal(stale.data.code,'OFFER_ALREADY_CLOSED');
    assert.equal((await pool.query('SELECT state FROM tala_core_v2.dispatch_offers WHERE id=$1',
      [next.offerId])).rows[0].state,'expired');
    assert.equal((await dispatchNext(pool)).state,'no_driver');

    await assert.rejects(recoverUncollectedAssignment(pool,assigned.orderId,5n,key()),
      error=>error.code==='RECOVERY_NOT_DUE');
    await pool.query(
      "UPDATE tala_core_v2.order_driver_assignments SET assigned_at=now()-interval '30 minutes' WHERE order_id=$1",
      [assigned.orderId]);
    // Explicit evidence of cash custody or PIN must STOP reassignment.
    await pool.query(
      "INSERT INTO tala_core_v2.order_handoffs(order_id,cash_amount_minor,pin_hash,pin_salt,pin_expires_at) SELECT id,total_minor,$2,$3,now()+interval '10 minutes' FROM tala_core_v2.orders WHERE id=$1",
      [assigned.orderId,'a'.repeat(128),'b'.repeat(32)]);
    await assert.rejects(recoverUncollectedAssignment(pool,assigned.orderId,5n,key()),
      error=>error.code==='RECOVERY_CUSTODY_REVIEW_REQUIRED');
    await pool.query('DELETE FROM tala_core_v2.order_handoffs WHERE order_id=$1',[assigned.orderId]);
    const recoverKey=key();
    const recovered=await recoverUncollectedAssignment(pool,assigned.orderId,5n,recoverKey);
    assert.equal(recovered.status,'ready');
    assert.equal(recovered.version,'6');
    const repeated=await recoverUncollectedAssignment(pool,assigned.orderId,5n,recoverKey);
    assert.equal(repeated.replayed,true);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM tala_core_v2.order_driver_assignments WHERE order_id=$1',
      [assigned.orderId])).rows[0].n,0);
    const revoked=await request('GET','/api/v2/driver/orders',undefined,driver.cookie);
    assert.equal(revoked.data.some(x=>x.id===assigned.orderId),false);
    const history=await pool.query(
      "SELECT count(*)::int AS n FROM tala_core_v2.outbox WHERE event_type LIKE 'dispatch.%' AND aggregate_id=ANY($1::uuid[])",
      [orders.map(o=>o.id)]);
    assert.ok(history.rows[0].n>=6);
  }finally{await new Promise(resolve=>server.close(resolve));await pool.end();}
});
