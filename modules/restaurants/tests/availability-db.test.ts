import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {RestaurantError} from '../src/domain.js';
import {createStore,createBranch,setBranchHours,setBranchActive,
  getBranchAvailability,changeStoreStatus} from '../src/stores.js';
import {createProduct,createVariant} from '../src/catalog.js';

const url=process.env.RESTAURANTS_CI_URL??'';
const enabled=/\/tala_restaurants_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
const fail=(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,
  (e:unknown)=>e instanceof RestaurantError&&e.code===code);

test('M6 real Jalisco timezone: opening times, branch pause, pickup and delivery',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:8});
  const owner={actorId:id()},stranger={actorId:id()};
  try{
    const store=await createStore(pool,owner,{
      operationId:id(),slug:'tacos-hours-'+id().slice(0,12),
      name:'Tacos del Centro',kind:'restaurant'});
    const branch=await createBranch(pool,owner,{
      storeId:store.id,operationId:id(),name:'Tala Centro',
      address:'Calle Juárez 123, Tala',
      city:'tala',pickupEnabled:true,deliveryEnabled:false});
    const schedule=await setBranchHours(pool,owner,{
      storeId:store.id,branchId:branch.id,expectedVersion:1,
      days:[{weekday:0,closed:true},{weekday:1,closed:false,
        openMinute:540,closeMinute:1260}]});
    assert.equal(schedule.version,2);
    const sample={storeId:store.id,branchId:branch.id,
      at:new Date('2026-11-02T17:00:00Z')}; // Monday 11:00 MX
    const draft=await getBranchAvailability(pool,sample);
    assert.equal(draft.isOpen,false);
    assert.equal(draft.reason,'STORE_NOT_READY');
    const product=await createProduct(pool,owner,{storeId:store.id,
      operationId:id(),name:'Taco de birria',category:'Comidas'});
    await createVariant(pool,owner,{storeId:store.id,productId:product.id,
      operationId:id(),label:'Orden de 5 tacos',priceCents:9500,
      stockQuantity:20,trackStock:true});
    await changeStoreStatus(pool,owner,{
      storeId:store.id,expectedVersion:1,status:'ready'});
    const open=await getBranchAvailability(pool,sample);
    assert.equal(open.timeZone,'America/Mexico_City');
    assert.equal(open.isOpen,true);
    assert.equal(open.pickupAvailable,true);
    assert.equal(open.deliveryAvailable,false);
    assert.equal(open.reason,'OPEN');
    const night=await getBranchAvailability(pool,{...sample,
      at:new Date('2026-11-03T05:00:00Z')}); // Mon 23:00 MX
    assert.equal(night.isOpen,false);
    assert.equal(night.reason,'OUTSIDE_HOURS');
    assert.equal((await getBranchAvailability(pool,{...sample,
      at:new Date('2026-11-01T17:00:00Z')})).isOpen,false);
    await fail(()=>setBranchActive(pool,stranger,{
      storeId:store.id,branchId:branch.id,
      expectedVersion:2,active:false}),'M6_FORBIDDEN');
    const paused=await setBranchActive(pool,owner,{
      storeId:store.id,branchId:branch.id,expectedVersion:2,active:false});
    assert.equal(paused.version,3);
    assert.equal((await getBranchAvailability(pool,sample)).reason,'BRANCH_PAUSED');
    await fail(()=>setBranchActive(pool,owner,{
      storeId:store.id,branchId:branch.id,
      expectedVersion:2,active:true}),'M6_VERSION_CONFLICT');
    await setBranchActive(pool,owner,{
      storeId:store.id,branchId:branch.id,expectedVersion:3,active:true});
    assert.equal((await getBranchAvailability(pool,sample)).isOpen,true);
    await fail(()=>getBranchAvailability(pool,{...sample,
      branchId:id()}),'M6_BRANCH_NOT_FOUND');
    await fail(()=>getBranchAvailability(pool,{...sample,
      at:new Date('bad')}),'M6_TIME_INVALID');
  }finally{await pool.end();}
});
