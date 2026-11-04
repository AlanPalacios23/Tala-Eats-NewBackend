import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {RestaurantError} from '../src/domain.js';
import {createStore,createBranch,setBranchHours,changeStoreStatus,
 setBranchActive} from '../src/stores.js';
import {createProduct,createVariant,adjustStock} from '../src/catalog.js';
import {enableBranchInventory,adjustBranchStock} from '../src/branch-stock.js';
import {setBranchVariantEnabled} from '../src/branch-catalog.js';
import {scheduleBranchClosure} from '../src/closures.js';
import {discoverReadyBranches} from '../src/discovery.js';

const url=process.env.RESTAURANTS_CI_URL??'';
const enabled=/\/tala_restaurants_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID(),when=new Date('2026-11-02T17:00:00Z');
const fail=(fn:()=>Promise<unknown>,code:string)=>
  assert.rejects(fn,(e:unknown)=>e instanceof RestaurantError&&e.code===code);

async function merchant(pool:pg.Pool,kind:'restaurant'|'florist',city:'tala'|'tequila'){
  const owner={actorId:id()};
  const store=await createStore(pool,owner,{operationId:id(),
    slug:'discover-'+id().slice(0,12),
    name:kind==='restaurant'?'Restaurante del Centro':'Flores Primavera',
    kind});
  const branch=await createBranch(pool,owner,{storeId:store.id,operationId:id(),
    name:'Sucursal Centro',address:'Calle del Mercado 18, Centro',
    city,pickupEnabled:true,deliveryEnabled:kind==='restaurant'});
  await setBranchHours(pool,owner,{storeId:store.id,branchId:branch.id,
    expectedVersion:1,days:[{
      weekday:1,closed:false,openMinute:540,closeMinute:1260}]});
  const product=await createProduct(pool,owner,{
    storeId:store.id,operationId:id(),name:'Producto local',
    category:kind==='restaurant'?'Comida':'Flores'});
  const variant=await createVariant(pool,owner,{storeId:store.id,
    productId:product.id,operationId:id(),label:'Unidad',
    priceCents:15000,stockQuantity:3,trackStock:true});
  await changeStoreStatus(pool,owner,{storeId:store.id,
    expectedVersion:1,status:'ready'});
  return {owner,store,branch,product,variant};
}
test('M6 local discovery finds ready stores by city and type, hides disabled menus',
 {skip:!enabled,timeout:85000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:12});
  try{
    const tala=await merchant(pool,'restaurant','tala');
    const tequila=await merchant(pool,'florist','tequila');
    const first=await discoverReadyBranches(pool,{city:'tala',at:when,
      search:'centro',kind:'restaurant'});
    assert.ok(first.items.some(x=>x.storeId===tala.store.id));
    assert.ok(!first.items.some(x=>x.storeId===tequila.store.id));
    const item=first.items.find(x=>x.storeId===tala.store.id)!;
    assert.equal(item.open,true);
    assert.equal(item.deliveryAvailable,true);
    assert.ok(!JSON.stringify(item).includes(tala.owner.actorId));
    assert.ok(!JSON.stringify(item).includes('address_text'));
    assert.ok(!JSON.stringify(item).includes('stock_quantity'));
    assert.equal((await discoverReadyBranches(pool,{city:'tequila',
      at:when,kind:'florist'})).items.some(x=>x.storeId===tequila.store.id),true);
    await scheduleBranchClosure(pool,tala.owner,{
      storeId:tala.store.id,branchId:tala.branch.id,operationId:id(),
      startsAt:'2026-11-02T16:00:00.000Z',
      endsAt:'2026-11-02T20:00:00.000Z',reason:'maintenance'});
    const closed=await discoverReadyBranches(pool,{city:'tala',at:when,
      kind:'restaurant'});
    const merchantClosed=closed.items.find(x=>x.storeId===tala.store.id)!;
    assert.equal(merchantClosed.open,false);
    assert.equal(merchantClosed.pickupAvailable,false);
    await setBranchVariantEnabled(pool,tala.owner,{
      storeId:tala.store.id,branchId:tala.branch.id,variantId:tala.variant.id,
      expectedVersion:0,enabled:false});
    assert.equal((await discoverReadyBranches(pool,{city:'tala',
      at:when,kind:'restaurant'})).items.some(x=>x.storeId===tala.store.id),false);
    assert.equal((await discoverReadyBranches(pool,{city:'tequila',
      at:when,kind:'florist'})).items.some(x=>x.storeId===tequila.store.id),true);
    await setBranchActive(pool,tequila.owner,{
      storeId:tequila.store.id,branchId:tequila.branch.id,
      expectedVersion:2,active:false});
    assert.equal((await discoverReadyBranches(pool,{
      city:'tequila',at:when})).items.some(x=>x.storeId===tequila.store.id),false);
    await fail(()=>discoverReadyBranches(pool,{
      city:'guadalajara' as never}),'M6_CITY_INVALID');
    await fail(()=>discoverReadyBranches(pool,{city:'tala',limit:100}),
      'M6_PAGE_INVALID');
  }finally{await pool.end();}
});


test('M6 LAB7 discovery never advertises branch stock held by another branch',
 {skip:!enabled,timeout:90000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:8});
  const owner={actorId:id()};
  try{
    const store=await createStore(pool,owner,{operationId:id(),
      slug:'discover-stock-'+id().slice(0,12),
      name:'Verduras Sucursal Segura',kind:'greengrocer'});
    const branches=[];
    for(const name of ['Tala Norte','Tala Sur']){
      const branch=await createBranch(pool,owner,{storeId:store.id,
        operationId:id(),name,address:'Mercado Municipal 22, Tala',city:'tala',
        pickupEnabled:true,deliveryEnabled:false});
      await setBranchHours(pool,owner,{storeId:store.id,branchId:branch.id,
        expectedVersion:1,days:[{weekday:1,closed:false,
          openMinute:540,closeMinute:1260}]});
      branches.push(branch);
    }
    const [north,south]=branches;
    assert.ok(north&&south);
    const product=await createProduct(pool,owner,{storeId:store.id,
      operationId:id(),name:'Tomate rojo',category:'Verduras'});
    const variant=await createVariant(pool,owner,{storeId:store.id,
      productId:product.id,operationId:id(),label:'500 g',weightGrams:500,
      priceCents:2500,stockQuantity:3,trackStock:true});
    await changeStoreStatus(pool,owner,{storeId:store.id,
      expectedVersion:1,status:'ready'});
    const visible=async()=>{
      const page=await discoverReadyBranches(pool,{city:'tala',at:when,
        kind:'greengrocer',search:'Sucursal Segura'});
      return page.items.filter(x=>x.storeId===store.id).map(x=>x.branchId).sort();
    };
    assert.deepEqual(await visible(),[north.id,south.id].sort());
    await adjustStock(pool,owner,{storeId:store.id,variantId:variant.id,
      operationId:id(),delta:-3,reason:'waste'});
    await enableBranchInventory(pool,owner,{storeId:store.id,
      variantId:variant.id,expectedVersion:2});
    // Neither branch inherits the former store-wide stock.
    assert.deepEqual(await visible(),[]);
    await adjustBranchStock(pool,owner,{storeId:store.id,
      branchId:north.id,variantId:variant.id,operationId:id(),
      delta:2,reason:'restock'});
    assert.deepEqual(await visible(),[north.id]);
    await adjustBranchStock(pool,owner,{storeId:store.id,
      branchId:south.id,variantId:variant.id,operationId:id(),
      delta:1,reason:'restock'});
    assert.deepEqual(await visible(),[north.id,south.id].sort());
    await adjustBranchStock(pool,owner,{storeId:store.id,
      branchId:north.id,variantId:variant.id,operationId:id(),
      delta:-2,reason:'waste'});
    assert.deepEqual(await visible(),[south.id]);
    await setBranchVariantEnabled(pool,owner,{storeId:store.id,
      branchId:south.id,variantId:variant.id,
      expectedVersion:0,enabled:false});
    assert.deepEqual(await visible(),[]);
  }finally{await pool.end();}
});
