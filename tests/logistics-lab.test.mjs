import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createOrderApp} from '../src/modules/orders/lab-http.ts';
import {hashPassword} from '../src/modules/orders/lab-auth.ts';

const db=process.env.PG_CI_URL??'';
const isolated=db.includes('/tala_core_v2_test');
const key=()=> 'cmd-'+randomUUID();
const pass='Driver-LAB-Strong-2026!';
test('LOGISTICA LAB1: capacidad serializada, GPS privado, idempotencia y presencia segura',
  {skip:!isolated,timeout:70000},async()=>{
  const pool=new Pool({connectionString:db,max:10});
  const server=createOrderApp(pool).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const req=async(method,path,body,cookie)=>{
    const r=await fetch(base+path,{method,headers:{
      ...(body!==undefined?{'Content-Type':'application/json'}:{}),
      ...(method!=='GET'?{'X-Talaeats-Client':'core-v2-lab'}:{}),
      ...(cookie?{Cookie:cookie}:{})
    },body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async(email)=>{
    const r=await req('POST','/api/v2/auth/login',{email,password:pass});
    assert.equal(r.status,200,JSON.stringify(r.data));return r.cookie;
  };
  try{
    const restaurant=randomUUID(),product=randomUUID();
    await pool.query("INSERT INTO tala_core_v2.restaurants(id,name,is_open) VALUES($1,'Restaurante LAB',true)",[restaurant]);
    await pool.query("INSERT INTO tala_core_v2.catalog_products(id,restaurant_id,name,price_minor,stock) VALUES($1,$2,'Producto LAB',8000,10)",[product,restaurant]);
    const actor=async(role)=>{
      const id=randomUUID(),email=role+'-'+randomUUID()+'@example.test';
      await pool.query("INSERT INTO tala_core_v2.accounts(id,email,display_name,password_hash,role) VALUES($1,$2,'Actor Logistica',$3,$4)",
        [id,email,await hashPassword(pass),role]);
      if(role==='merchant')await pool.query(
        "INSERT INTO tala_core_v2.restaurant_memberships(restaurant_id,member_id,is_active) VALUES($1,$2,true)",[restaurant,id]);
      if(role==='driver')await pool.query(
        "INSERT INTO tala_core_v2.driver_profiles(account_id,approved,is_online) VALUES($1,true,true)",[id]);
      return {id,cookie:await login(email)};
    };
    const buyer=await actor('customer'),merchant=await actor('merchant'),driver=await actor('driver');
    const invalid=await req('POST','/api/v2/driver/presence',
      {online:false,expectedVersion:'1',commandKey:key()},buyer.cookie);
    assert.equal(invalid.status,403);
    const initial=await req('GET','/api/v2/driver/logistics',undefined,driver.cookie);
    assert.equal(initial.status,200);
    assert.equal(initial.data.online,true);
    assert.equal(initial.data.activeDeliveries,0);
    assert.equal(initial.data.capacity,1);
    const gps={latitude:20.65,longitude:-103.7,accuracyMeters:12,
      sequence:'1',observedAt:new Date().toISOString()};
    const premature=await req('POST','/api/v2/driver/location',gps,driver.cookie);
    assert.equal(premature.status,409);
    assert.equal(premature.data.code,'LOCATION_REQUIRES_ACTIVE_DELIVERY');

    const orders=[];
    for(let i=0;i<2;i++){
      const created=await req('POST','/api/v2/orders',{
        restaurantId:restaurant,fulfillment:'delivery',deliveryAddress:'Calle LAB 100 Tala',
        lines:[{productId:product,quantity:1}],paymentMethod:'cash',idempotencyKey:key()
      },buyer.cookie);
      assert.equal(created.status,201,JSON.stringify(created.data));
      const id=created.data.order.id;let version='1';
      for(const status of ['confirmed','preparing','ready']){
        const advanced=await req('PATCH','/api/v2/merchant/orders/'+id+'/status',
          {status,expectedVersion:version,commandKey:key()},merchant.cookie);
        assert.equal(advanced.status,200,JSON.stringify(advanced.data));
        version=advanced.data.version;
      }
      orders.push({id,version});
    }
    const [first,second]=await Promise.all(orders.map(o=>
      req('POST','/api/v2/driver/orders/'+o.id+'/claim',
        {expectedVersion:o.version,commandKey:key()},driver.cookie)));
    assert.deepEqual([first.status,second.status].sort(),[200,409]);
    const accepted=first.status===200?orders[0]:orders[1];
    const rejected=first.status===409?first:second;
    assert.equal(rejected.data.code,'DRIVER_CAPACITY_EXCEEDED');
    const active=await req('GET','/api/v2/driver/logistics',undefined,driver.cookie);
    assert.equal(active.data.activeDeliveries,1);
    assert.equal((await req('GET','/api/v2/driver/available',undefined,driver.cookie))
      .data.some(x=>x.id===orders[0].id||x.id===orders[1].id),false);
    const offlineCmd={online:false,expectedVersion:'1',commandKey:key()};
    const blocked=await req('POST','/api/v2/driver/presence',offlineCmd,driver.cookie);
    assert.equal(blocked.status,409);
    assert.equal(blocked.data.code,'ACTIVE_DELIVERY_MUST_FINISH');
    const gpsRecorded=await req('POST','/api/v2/driver/location',gps,driver.cookie);
    assert.equal(gpsRecorded.status,200,JSON.stringify(gpsRecorded.data));
    assert.equal(gpsRecorded.data.replayed,false);
    const duplicate=await req('POST','/api/v2/driver/location',gps,driver.cookie);
    assert.equal(duplicate.status,200);
    assert.equal(duplicate.data.replayed,true);
    const changed=await req('POST','/api/v2/driver/location',
      {...gps,latitude:20.66},driver.cookie);
    assert.equal(changed.status,409);
    assert.equal(changed.data.code,'LOCATION_SEQUENCE_CONFLICT');
    const stale=await req('POST','/api/v2/driver/location',
      {...gps,sequence:'0'},driver.cookie);
    assert.equal(stale.status,400);
    const buyerGps=await req('POST','/api/v2/driver/location',gps,buyer.cookie);
    assert.equal(buyerGps.status,403);
    const row=await pool.query(
      'SELECT latitude_micro,longitude_micro FROM tala_core_v2.driver_latest_locations WHERE driver_id=$1',[driver.id]);
    assert.equal(row.rows.length,1);
    assert.equal(row.rows[0].latitude_micro,20650000);
    assert.equal(row.rows[0].longitude_micro,-103700000);

    let version='5';
    for(const status of ['picked_up','on_the_way']){
      const r=await req('PATCH','/api/v2/driver/orders/'+accepted.id+'/status',
        {status,expectedVersion:version,commandKey:key()},driver.cookie);
      assert.equal(r.status,200,JSON.stringify(r.data));
      version=r.data.version;
    }
    const pin=await req('POST','/api/v2/orders/'+accepted.id+'/handoff-pin',{},buyer.cookie);
    assert.equal(pin.status,200,JSON.stringify(pin.data));
    assert.equal((await req('POST','/api/v2/orders/'+accepted.id+'/cash-paid',{},buyer.cookie)).status,200);
    assert.equal((await req('POST','/api/v2/driver/orders/'+accepted.id+'/cash-received',{},driver.cookie)).status,200);
    const done=await req('POST','/api/v2/driver/orders/'+accepted.id+'/complete',
      {expectedVersion:version,commandKey:key(),pin:pin.data.pin},driver.cookie);
    assert.equal(done.status,200,JSON.stringify(done.data));
    // GPS must be erased at successful delivery, not just after logout.
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM tala_core_v2.driver_latest_locations WHERE driver_id=$1',
      [driver.id])).rows[0].n,0);
    const finished=await req('GET','/api/v2/driver/logistics',undefined,driver.cookie);
    assert.equal(finished.data.locationFresh,false);
    assert.equal(finished.data.activeDeliveries,0);
    const offline=await req('POST','/api/v2/driver/presence',offlineCmd,driver.cookie);
    assert.equal(offline.status,200,JSON.stringify(offline.data));
    assert.equal(offline.data.presenceVersion,'2');
    const replay=await req('POST','/api/v2/driver/presence',offlineCmd,driver.cookie);
    assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM tala_core_v2.driver_latest_locations WHERE driver_id=$1',
      [driver.id])).rows[0].n,0);
    const denied=await req('POST','/api/v2/driver/presence',
      {...offlineCmd,online:true},driver.cookie);
    assert.equal(denied.status,409);assert.equal(denied.data.code,'IDEMPOTENCY_CONFLICT');
    const online=await req('POST','/api/v2/driver/presence',
      {online:true,expectedVersion:'2',commandKey:key()},driver.cookie);
    assert.equal(online.status,200);
    assert.equal(online.data.presenceVersion,'3');
    const available=await req('GET','/api/v2/driver/available',undefined,driver.cookie);
    assert.equal(available.status,200);
    assert.equal(available.data.some(x=>x.id!==accepted.id&&orders.some(o=>o.id===x.id)),true);
    const outbox=await pool.query(
      "SELECT count(*)::int AS n FROM tala_core_v2.outbox WHERE aggregate_id=$1 AND event_type='driver.presence.changed'",
      [driver.id]);
    assert.equal(outbox.rows[0].n,2);
  }finally{
    await new Promise(resolve=>server.close(resolve));await pool.end();
  }
});
