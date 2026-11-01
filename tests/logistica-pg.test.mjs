import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {enrollCourier,approveCourier,setCourierOnline,reserveDelivery,
  finalizeDispatch,LogisticsError} from '../src/modules/modulo-2-logistica/index.ts';

const raw=process.env.PG_CI_URL ?? '';
const enabled=(()=>{
  try{const url=new URL(raw);return url.pathname==='/tala_core_v2_test'
    &&['127.0.0.1','localhost'].includes(url.hostname);}
  catch{return false;}
})();
const k=()=> 'command-'+randomUUID();
// Isolate every test from other persistent fixtures inside the shared disposable CI database.
let testZone='tala';
test.beforeEach(()=>{testZone='z_'+randomUUID().slice(0,12);});
const input=(orderId=randomUUID(),zone=testZone)=>({
  orderId,restaurantId:randomUUID(),
  orderStatus:'ready',fulfillment:'delivery',deliveryZone:zone
});
const pool=()=>new Pool({connectionString:raw,max:10,connectionTimeoutMillis:3000});
const setup=async(p,zone=testZone,capacity=1)=>{
  const id=randomUUID();
  await enrollCourier(p,id,zone,capacity);
  await approveCourier(p,id,true);
  await setCourierOnline(p,id,true);
  return id;
};
const rejectCode=code=>err=>err instanceof LogisticsError&&err.code===code;

test('Logística SQL: tablas en esquema independiente y sin dependencia directa de Pedidos',{
  skip:!enabled
},async()=>{
  const p=pool();
  try{
    const q=await p.query(`SELECT
      to_regclass('tala_logistics_v2.couriers') IS NOT NULL AS couriers,
      to_regclass('tala_logistics_v2.dispatch_reservations') IS NOT NULL AS dispatches,
      to_regclass('tala_logistics_v2.dispatch_events') IS NOT NULL AS events,
      to_regclass('tala_logistics_v2.outbox') IS NOT NULL AS outbox,
      to_regclass('tala_core_v2.orders') IS NOT NULL AS orders`);
    assert.deepEqual(q.rows[0],{
      couriers:true,dispatches:true,events:true,outbox:true,orders:true
    });
    const fks=await p.query(`
      SELECT count(*)::int AS n FROM pg_constraint con
      JOIN pg_namespace n ON n.oid=con.connamespace
      WHERE n.nspname='tala_logistics_v2' AND con.contype='f'
        AND con.confrelid IN (
          SELECT c.oid FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
          WHERE s.nspname='tala_core_v2'
        )`);
    assert.equal(fks.rows[0].n,0);
  }finally{await p.end();}
});

test('Logística: alta no aprueba, heartbeat exige aprobación, revocación desconecta',{
  skip:!enabled
},async()=>{
  const p=pool();
  try{
    const id=randomUUID();
    await enrollCourier(p,id,'tala',2);
    await assert.rejects(setCourierOnline(p,id,true),
      rejectCode('LOGISTICS_COURIER_NOT_APPROVED'));
    await approveCourier(p,id,true);
    await setCourierOnline(p,id,true);
    let q=await p.query('SELECT approved,online,last_seen_at FROM tala_logistics_v2.couriers WHERE id=$1',[id]);
    assert.equal(q.rows[0].approved,true);
    assert.equal(q.rows[0].online,true);
    assert.ok(q.rows[0].last_seen_at);
    await approveCourier(p,id,false);
    q=await p.query('SELECT approved,online FROM tala_logistics_v2.couriers WHERE id=$1',[id]);
    assert.deepEqual(q.rows[0],{approved:false,online:false});
    await assert.rejects(setCourierOnline(p,id,true),
      rejectCode('LOGISTICS_COURIER_NOT_APPROVED'));
  }finally{await p.end();}
});

test('Logística: reserva persistente crea 1 evento y outbox, retry misma llave no duplica',{
  skip:!enabled
},async()=>{
  const p=pool();
  try{
    const id=await setup(p);
    const r=input(),cmd=k();
    const a=await reserveDelivery(p,r,cmd);
    assert.deepEqual(a,{
      decision:'RESERVED',orderId:r.orderId,courierId:id,
      status:'reserved',version:'1',replayed:false
    });
    const again=await reserveDelivery(p,r,cmd);
    assert.deepEqual(again,{...a,replayed:true});
    await assert.rejects(reserveDelivery(p,r,k()),
      rejectCode('LOGISTICS_ORDER_ALREADY_RESERVED'));
    await assert.rejects(reserveDelivery(p,{...r,deliveryZone:'tequila'},cmd),
      rejectCode('LOGISTICS_ORDER_CONFLICT'));
    const q=await p.query(`
      SELECT
       (SELECT count(*)::int FROM tala_logistics_v2.dispatch_reservations WHERE order_id=$1) dispatches,
       (SELECT count(*)::int FROM tala_logistics_v2.dispatch_events WHERE order_id=$1) events,
       (SELECT count(*)::int FROM tala_logistics_v2.outbox b
         JOIN tala_logistics_v2.dispatch_events e ON e.event_key=b.event_key
         WHERE e.order_id=$1) outbox`,[r.orderId]);
    assert.deepEqual(q.rows[0],{dispatches:1,events:1,outbox:1});
  }finally{await p.end();}
});

test('Logística: un pedido pickup o en preparación no consume capacidad',{
  skip:!enabled
},async()=>{
  const p=pool();
  try{
    const id=await setup(p),r=input();
    assert.deepEqual(await reserveDelivery(p,{...r,fulfillment:'pickup'},k()),{
      decision:'NOT_ELIGIBLE',orderId:r.orderId
    });
    assert.deepEqual(await reserveDelivery(p,{...r,orderStatus:'preparing'},k()),{
      decision:'NOT_ELIGIBLE',orderId:r.orderId
    });
    const eligible=await reserveDelivery(p,r,k());
    assert.equal(eligible.decision,'RESERVED');
    if(eligible.decision==='RESERVED')assert.equal(eligible.courierId,id);
  }finally{await p.end();}
});

test('Logística: rechaza conductor en zona incorrecta, desconectado o presencia obsoleta',{
  skip:!enabled
},async()=>{
  const p=pool();
  try{
    const secondary='tequila_'+randomUUID().slice(0,12);
    const id=await setup(p,secondary);
    assert.equal((await reserveDelivery(p,input(),k())).decision,'NO_AVAILABLE_COURIER');
    await setCourierOnline(p,id,false);
    assert.equal((await reserveDelivery(p,input(randomUUID(),secondary),k())).decision,
      'NO_AVAILABLE_COURIER');
    await setCourierOnline(p,id,true);
    await p.query(`
      UPDATE tala_logistics_v2.couriers
      SET last_seen_at=clock_timestamp()-interval '3 minutes' WHERE id=$1`,[id]);
    assert.equal((await reserveDelivery(p,input(randomUUID(),secondary),k())).decision,
      'NO_AVAILABLE_COURIER');
  }finally{await p.end();}
});

test('Logística: capacidad 1 bajo dos reservas simultáneas, nunca sobreasignación',{
  skip:!enabled,timeout:25000
},async()=>{
  const p=pool();
  try{
    const id=await setup(p);
    const results=await Promise.all([
      reserveDelivery(p,input(),k()),reserveDelivery(p,input(),k())
    ]);
    assert.equal(results.filter(x=>x.decision==='RESERVED').length,1);
    assert.equal(results.filter(x=>x.decision==='NO_AVAILABLE_COURIER').length,1);
    const count=await p.query(`
      SELECT count(*)::int AS n FROM tala_logistics_v2.dispatch_reservations
      WHERE courier_id=$1 AND status='reserved'`,[id]);
    assert.equal(count.rows[0].n,1);
  }finally{await p.end();}
});

test('Logística: la misma orden concurrente nunca obtiene dos asignaciones',{
  skip:!enabled,timeout:25000
},async()=>{
  const p=pool();
  try{
    await setup(p,testZone,2);await setup(p,testZone,2);
    const r=input(),cmd=k();
    const results=await Promise.allSettled([
      reserveDelivery(p,r,cmd),reserveDelivery(p,r,cmd)
    ]);
    assert.equal(results.every(x=>x.status==='fulfilled'),true);
    const fulfilled=results.filter(x=>x.status==='fulfilled').map(x=>x.value);
    assert.equal(fulfilled[0].courierId,fulfilled[1].courierId);
    assert.deepEqual(fulfilled.map(x=>x.replayed).sort(),[false,true]);
    const count=await p.query('SELECT count(*)::int AS n FROM tala_logistics_v2.dispatch_events WHERE order_id=$1',[r.orderId]);
    assert.equal(count.rows[0].n,1);
  }finally{await p.end();}
});

test('Logística: release devuelve capacidad, guarda eventos y no permite reabrir orden',{
  skip:!enabled
},async()=>{
  const p=pool();
  try{
    const id=await setup(p,testZone,1),r=input();
    const created=await reserveDelivery(p,r,k());
    assert.equal(created.decision,'RESERVED');
    await assert.rejects(finalizeDispatch(p,r.orderId,'2',k(),'released'),
      rejectCode('LOGISTICS_VERSION_CONFLICT'));
    const finalKey=k();
    const closed=await finalizeDispatch(p,r.orderId,'1',finalKey,'released');
    assert.deepEqual(closed,{
      orderId:r.orderId,courierId:id,status:'released',version:'2',replayed:false
    });
    assert.deepEqual(await finalizeDispatch(p,r.orderId,'1',finalKey,'released'),
      {...closed,replayed:true});
    await assert.rejects(finalizeDispatch(p,r.orderId,'2',k(),'completed'),
      rejectCode('LOGISTICS_DISPATCH_FINALIZED'));
    await assert.rejects(reserveDelivery(p,r,k()),
      rejectCode('LOGISTICS_DISPATCH_FINALIZED'));
    const next=await reserveDelivery(p,input(),k());
    assert.equal(next.decision,'RESERVED');
    const q=await p.query('SELECT count(*)::int AS n FROM tala_logistics_v2.dispatch_events WHERE order_id=$1',[r.orderId]);
    assert.equal(q.rows[0].n,2);
  }finally{await p.end();}
});

test('Logística: cierre completed libera capacidad y eventos son append-only',{
  skip:!enabled
},async()=>{
  const p=pool();
  try{
    await setup(p);
    const r=input(),reserve=await reserveDelivery(p,r,k());
    assert.equal(reserve.decision,'RESERVED');
    const complete=await finalizeDispatch(p,r.orderId,'1',k(),'completed');
    assert.equal(complete.status,'completed');
    assert.equal(complete.version,'2');
    await assert.rejects(p.query(
      'DELETE FROM tala_logistics_v2.dispatch_events WHERE order_id=$1',[r.orderId]
    ),e=>e.code==='23514');
    const status=await p.query('SELECT status,version FROM tala_logistics_v2.dispatch_reservations WHERE order_id=$1',[r.orderId]);
    assert.deepEqual(status.rows[0],{status:'completed',version:'2'});
    assert.equal((await reserveDelivery(p,input(),k())).decision,'RESERVED');
  }finally{await p.end();}
});

test('Logística: no se confunden roles ni se admiten tamaños y zonas inválidos',{
  skip:!enabled
},async()=>{
  const p=pool();
  try{
    await assert.rejects(enrollCourier(p,randomUUID(),'tala',9),
      rejectCode('LOGISTICS_CAPACITY_INVALID'));
    await assert.rejects(enrollCourier(p,randomUUID(),'../tala',1),
      rejectCode('LOGISTICS_ZONE_INVALID'));
    await assert.rejects(reserveDelivery(p,{...input(),deliveryZone:'INVALID!'},k()),
      rejectCode('LOGISTICS_ZONE_INVALID'));
    await assert.rejects(reserveDelivery(p,input(),'short'),
      rejectCode('LOGISTICS_COMMAND_KEY_INVALID'));
  }finally{await p.end();}
});

test('Logística: si repartidor A está lleno, asigna B con capacidad disponible',{
  skip:!enabled
},async()=>{
  const p=pool();
  try{
    const a=await setup(p,testZone,1);
    const b=await setup(p,testZone,1);
    const [first,second]=await Promise.all([
      reserveDelivery(p,input(),k()),
      reserveDelivery(p,input(),k())
    ]);
    assert.equal(first.decision,'RESERVED');
    assert.equal(second.decision,'RESERVED');
    if(first.decision==='RESERVED'&&second.decision==='RESERVED'){
      assert.notEqual(first.courierId,second.courierId);
      assert.deepEqual([first.courierId,second.courierId].sort(),[a,b].sort());
    }
  }finally{await p.end();}
});
