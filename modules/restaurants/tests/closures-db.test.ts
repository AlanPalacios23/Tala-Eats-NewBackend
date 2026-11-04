import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {RestaurantError} from '../src/domain.js';
import {createStore,createBranch,setBranchHours,changeStoreStatus,
 setStaffRole,getBranchAvailability} from '../src/stores.js';
import {createProduct,createVariant} from '../src/catalog.js';
import {scheduleBranchClosure,cancelBranchClosure,
 listBranchClosures} from '../src/closures.js';

const url=process.env.RESTAURANTS_CI_URL??'';
const enabled=/\/tala_restaurants_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
const fails=(callback:()=>Promise<unknown>,code:string)=>
  assert.rejects(callback,(e:unknown)=>
    e instanceof RestaurantError&&e.code===code);

test('M6 branch exception closures: holiday schedule overrides opening and restores on cancellation',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:12});
  const owner={actorId:id()},manager={actorId:id()},
    editor={actorId:id()},outsider={actorId:id()};
  try{
    const store=await createStore(pool,owner,{
      operationId:id(),slug:'restaurant-exc-'+id().slice(0,12),
      name:'Restaurante Las Flores',kind:'restaurant'});
    await setStaffRole(pool,owner,{storeId:store.id,memberId:manager.actorId,role:'manager'});
    await setStaffRole(pool,owner,{storeId:store.id,memberId:editor.actorId,role:'editor'});
    const branch=await createBranch(pool,owner,{
      storeId:store.id,operationId:id(),name:'Tala Centro',
      address:'Calle Hidalgo 52, Tala',city:'tala',
      pickupEnabled:true,deliveryEnabled:true});
    const second=await createBranch(pool,owner,{
      storeId:store.id,operationId:id(),name:'Tala Norte',
      address:'Calle Norte 73, Tala',city:'tala',
      pickupEnabled:true,deliveryEnabled:false});
    await setBranchHours(pool,owner,{
      storeId:store.id,branchId:branch.id,expectedVersion:1,
      days:[{weekday:1,closed:false,openMinute:540,closeMinute:1260}]});
    await setBranchHours(pool,owner,{
      storeId:store.id,branchId:second.id,expectedVersion:1,
      days:[{weekday:1,closed:false,openMinute:540,closeMinute:1260}]});
    const product=await createProduct(pool,owner,{
      storeId:store.id,operationId:id(),
      name:'Enchiladas rojas',category:'Comida'});
    await createVariant(pool,owner,{
      storeId:store.id,productId:product.id,operationId:id(),
      label:'Orden',priceCents:8900,stockQuantity:8,trackStock:true});
    await changeStoreStatus(pool,owner,{
      storeId:store.id,expectedVersion:1,status:'ready'});
    const at=new Date('2026-11-02T17:00:00Z'); // Monday 11:00 Jalisco
    const sample={storeId:store.id,branchId:branch.id,at};
    assert.equal((await getBranchAvailability(pool,sample)).isOpen,true);
    const request={storeId:store.id,branchId:branch.id,operationId:id(),
      startsAt:'2026-11-02T16:00:00.000Z',
      endsAt:'2026-11-02T19:00:00.000Z',
      reason:'holiday' as const};
    const closed=await scheduleBranchClosure(pool,manager,request);
    assert.equal(closed.replayed,false);
    assert.equal((await scheduleBranchClosure(pool,manager,request)).id,closed.id);
    assert.equal((await scheduleBranchClosure(pool,manager,request)).replayed,true);
    await fails(()=>scheduleBranchClosure(pool,manager,{
      ...request,reason:'other'}),'M6_IDEMPOTENCY_CONFLICT');
    await fails(()=>scheduleBranchClosure(pool,owner,{
      ...request,operationId:id(),startsAt:'2026-11-02T17:00:00.000Z',
      endsAt:'2026-11-02T20:00:00.000Z'}),'M6_CLOSURE_OVERLAP');
    await fails(()=>scheduleBranchClosure(pool,editor,{
      ...request,operationId:id()}),'M6_FORBIDDEN');
    await fails(()=>scheduleBranchClosure(pool,outsider,{
      ...request,operationId:id()}),'M6_FORBIDDEN');
    const unavailable=await getBranchAvailability(pool,sample);
    assert.equal(unavailable.isOpen,false);
    assert.equal(unavailable.reason,'EXCEPTIONAL_CLOSURE');
    assert.equal(unavailable.deliveryAvailable,false);
    assert.equal(unavailable.pickupAvailable,false);
    assert.equal((await getBranchAvailability(pool,{
      storeId:store.id,branchId:second.id,at
    })).isOpen,true);
    assert.equal((await listBranchClosures(pool,owner,{
      storeId:store.id,branchId:branch.id})).closures.length,1);
    await fails(()=>listBranchClosures(pool,outsider,{
      storeId:store.id,branchId:branch.id}),'M6_FORBIDDEN');
    assert.equal((await cancelBranchClosure(pool,editor,{
      storeId:store.id,branchId:branch.id,closureId:closed.id
    }).catch(e=>{if(e instanceof RestaurantError)throw e;throw e})),undefined);
  }finally{await pool.end();}
});
