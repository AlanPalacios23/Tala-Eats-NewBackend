import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {RestaurantError} from '../src/domain.js';
import {createStore,readStore,listMyStores,updateStore,setStaffRole,
 createBranch,setBranchHours,listBranches,changeStoreStatus} from '../src/stores.js';
import {createProduct,createVariant} from '../src/catalog.js';

const url=process.env.RESTAURANTS_CI_URL??'';
const enabled=/\/tala_restaurants_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID(),db=()=>new pg.Pool({connectionString:url,max:12});
const fail=(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,
  (e:unknown)=>e instanceof RestaurantError&&e.code===code);
function uniqueSlug(prefix:string){return prefix+'-'+id().slice(0,12);}
test('M6 stores: idempotent onboarding, owner/manager/editor RBAC and version conflicts',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=db(),owner={actorId:id()},manager={actorId:id()},
    editor={actorId:id()},stranger={actorId:id()};
  try{
    const input={operationId:id(),slug:uniqueSlug('tala-restaurant'),
      name:'Antojitos La Terraza',kind:'restaurant' as const,
      description:'Comida preparada'};
    const store=await createStore(pool,owner,input);
    assert.equal(store.replayed,false);
    const repeated=await createStore(pool,owner,input);
    assert.equal(repeated.id,store.id);
    assert.equal(repeated.replayed,true);
    await fail(()=>createStore(pool,owner,{...input,name:'Copia no autorizada'}),
      'M6_IDEMPOTENCY_CONFLICT');
    assert.equal((await listMyStores(pool,owner)).length,1);
    assert.equal((await listMyStores(pool,stranger)).length,0);
    const view=await readStore(pool,owner,store.id);
    assert.equal(view.store.version,1);
    assert.equal(view.store.owner_id,owner.actorId);
    assert.deepEqual(view.staff.map(x=>x.role),['owner']);
    await fail(()=>readStore(pool,stranger,store.id),'M6_FORBIDDEN');
    await fail(()=>updateStore(pool,stranger,{
      storeId:store.id,expectedVersion:1,name:'Intruso'}),'M6_FORBIDDEN');
    await setStaffRole(pool,owner,{
      storeId:store.id,memberId:manager.actorId,role:'manager'});
    await setStaffRole(pool,owner,{
      storeId:store.id,memberId:editor.actorId,role:'editor'});
    assert.equal((await readStore(pool,manager,store.id)).store.id,store.id);
    await fail(()=>setStaffRole(pool,manager,{
      storeId:store.id,memberId:stranger.actorId,role:'manager'}),'M6_FORBIDDEN');
    await fail(()=>updateStore(pool,editor,{
      storeId:store.id,expectedVersion:1,name:'Edit unauthorized'}),'M6_FORBIDDEN');
    const updated=await updateStore(pool,manager,{
      storeId:store.id,expectedVersion:1,name:'Antojitos La Terraza Tala'});
    assert.equal(updated.version,2);
    await fail(()=>updateStore(pool,owner,{
      storeId:store.id,expectedVersion:1,name:'Old version'}),'M6_VERSION_CONFLICT');
    await fail(()=>setStaffRole(pool,owner,{
      storeId:store.id,memberId:owner.actorId,role:null}),'M6_OWNER_IMMUTABLE');
    await fail(()=>changeStoreStatus(pool,manager,{
      storeId:store.id,expectedVersion:2,status:'ready'}),'M6_FORBIDDEN');
    await fail(()=>changeStoreStatus(pool,owner,{
      storeId:store.id,expectedVersion:2,status:'ready'}),'M6_ONBOARDING_INCOMPLETE');
    await setStaffRole(pool,owner,{
      storeId:store.id,memberId:editor.actorId,role:null});
    await fail(()=>readStore(pool,editor,store.id),'M6_FORBIDDEN');
    const audit=await pool.query(
      'SELECT action FROM tala_restaurants_v2.audit WHERE store_id=$1',
      [store.id]);
    assert.ok(audit.rows.length>=4);
    await assert.rejects(
      pool.query("DELETE FROM tala_restaurants_v2.audit WHERE store_id=$1",[store.id]),
      (e:unknown)=>e instanceof Error&&e.message.includes('RESTAURANTS_AUDIT_IMMUTABLE'));
  }finally{await pool.end();}
});
test('M6 branches: pilot Tala/future cities, safe pickup/delivery and versioned hours',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=db(),owner={actorId:id()},other={actorId:id()};
  try{
    const store=await createStore(pool,owner,{
      operationId:id(),slug:uniqueSlug('abarrotes'),
      name:'Abarrotes Tala',kind:'grocery'});
    const branchInput={storeId:store.id,operationId:id(),name:'Sucursal Centro',
      address:'Calle Principal 123',city:'tala' as const,
      pickupEnabled:true,deliveryEnabled:true,latitude:20.653,longitude:-103.704};
    const first=await createBranch(pool,owner,branchInput);
    assert.equal((await createBranch(pool,owner,branchInput)).replayed,true);
    await fail(()=>createBranch(pool,owner,{...branchInput,
      pickupEnabled:false,deliveryEnabled:false,
      operationId:id()}),'M6_FULFILLMENT_INVALID');
    await fail(()=>createBranch(pool,owner,{...branchInput,
      latitude:120,operationId:id()}),'M6_COORDINATES_INVALID');
    await fail(()=>createBranch(pool,other,{
      ...branchInput,operationId:id()}),'M6_FORBIDDEN');
    const days=[
      {weekday:0,closed:true},
      {weekday:1,closed:false,openMinute:540,closeMinute:1260},
      {weekday:2,closed:false,openMinute:600,closeMinute:1230}
    ];
    await fail(()=>setBranchHours(pool,owner,{
      storeId:store.id,branchId:first.id,expectedVersion:1,
      days:[{weekday:1,closed:false,openMinute:1000,closeMinute:900}]
    }),'M6_HOURS_INVALID');
    const update=await setBranchHours(pool,owner,{
      storeId:store.id,branchId:first.id,expectedVersion:1,days});
    assert.equal(update.version,2);
    await fail(()=>setBranchHours(pool,owner,{
      storeId:store.id,branchId:first.id,expectedVersion:1,days}),'M6_VERSION_CONFLICT');
    const branches=await listBranches(pool,owner,store.id);
    assert.equal(branches.branches.length,1);
    assert.equal(branches.hours.length,3);
    assert.equal(branches.hours.find(x=>x.weekday===0)?.closed,true);
    await fail(()=>listBranches(pool,other,store.id),'M6_FORBIDDEN');
  }finally{await pool.end();}
});
test('M6 ready gate: requires open branch and an available fixed-price variant',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=db(),owner={actorId:id()};
  try{
    const store=await createStore(pool,owner,{
      operationId:id(),slug:uniqueSlug('carniceria'),
      name:'Carnicería de Tala',kind:'butcher'});
    const branch=await createBranch(pool,owner,{
      storeId:store.id,operationId:id(),name:'Carnicería Centro',
      address:'Calle Mercado 100',city:'tala',pickupEnabled:true,deliveryEnabled:false});
    await setBranchHours(pool,owner,{
      storeId:store.id,branchId:branch.id,expectedVersion:1,
      days:[{weekday:1,closed:false,openMinute:480,closeMinute:1080}]});
    await fail(()=>changeStoreStatus(pool,owner,{
      storeId:store.id,expectedVersion:1,status:'ready'
    }),'M6_ONBOARDING_INCOMPLETE');
    const product=await createProduct(pool,owner,{
      storeId:store.id,operationId:id(),name:'Carne de res',category:'Carnes'});
    const variant=await createVariant(pool,owner,{
      storeId:store.id,productId:product.id,operationId:id(),label:'500 g',
      weightGrams:500,priceCents:12000,stockQuantity:6,trackStock:true});
    assert.ok(variant.id);
    const changed=await changeStoreStatus(pool,owner,{
      storeId:store.id,expectedVersion:1,status:'ready'});
    assert.equal(changed.status,'ready');
    assert.equal(changed.version,2);
    const paused=await changeStoreStatus(pool,owner,{
      storeId:store.id,expectedVersion:2,status:'paused'});
    assert.equal(paused.status,'paused');
  }finally{await pool.end();}
});
