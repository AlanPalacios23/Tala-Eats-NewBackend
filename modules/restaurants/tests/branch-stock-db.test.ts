import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {RestaurantError} from '../src/domain.js';
import {createStore,createBranch,setBranchHours,changeStoreStatus} from '../src/stores.js';
import {createProduct,createVariant,adjustStock,readOfferSnapshot} from '../src/catalog.js';
import {enableBranchInventory,adjustBranchStock,readBranchStock} from '../src/branch-stock.js';
import {readBranchStorefront} from '../src/branch-catalog.js';
import {readMerchantOverview} from '../src/overview.js';
const url=process.env.RESTAURANTS_CI_URL??'';
const enabled=/\/tala_restaurants_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
const fail=(f:()=>Promise<unknown>,code:string)=>assert.rejects(f,
 (e:unknown)=>e instanceof RestaurantError&&e.code===code);
const mon=new Date('2026-11-02T17:00:00Z');

test('M6 LAB5 isolated stock: zero migration, branch-specific availability, immutable audit and concurrent depletion',
 {skip:!enabled,timeout:120000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:20});
  const owner={actorId:id()},outsider={actorId:id()};
  try{
    const store=await createStore(pool,owner,{operationId:id(),
      slug:'branchstock-'+id().slice(0,12),name:'Frutas del Centro',kind:'greengrocer'});
    const north=await createBranch(pool,owner,{storeId:store.id,operationId:id(),
      name:'Sucursal Norte',address:'Centro 123, Tala',city:'tala',
      pickupEnabled:true,deliveryEnabled:false});
    const south=await createBranch(pool,owner,{storeId:store.id,operationId:id(),
      name:'Sucursal Sur',address:'Sur 456, Tala',city:'tala',
      pickupEnabled:true,deliveryEnabled:false});
    for(const b of [north,south]){
      await setBranchHours(pool,owner,{storeId:store.id,branchId:b.id,
        expectedVersion:1,days:[{weekday:1,closed:false,
          openMinute:540,closeMinute:1260}]});
    }
    const p=await createProduct(pool,owner,{storeId:store.id,operationId:id(),
      name:'Jitomate',category:'Verduras'});
    const v=await createVariant(pool,owner,{storeId:store.id,productId:p.id,
      operationId:id(),label:'500 g',weightGrams:500,priceCents:2500,
      stockQuantity:3,trackStock:true});
    await changeStoreStatus(pool,owner,{storeId:store.id,
      expectedVersion:1,status:'ready'});
    await fail(()=>enableBranchInventory(pool,owner,{storeId:store.id,
      variantId:v.id,expectedVersion:1}),'M6_BRANCH_STOCK_SWITCH_CONFLICT');
    await adjustStock(pool,owner,{storeId:store.id,variantId:v.id,
      operationId:id(),delta:-3,reason:'waste'});
    const switched=await enableBranchInventory(pool,owner,{storeId:store.id,
      variantId:v.id,expectedVersion:2});
    assert.equal(switched.branchStockEnabled,true);
    await fail(()=>enableBranchInventory(pool,owner,{storeId:store.id,
      variantId:v.id,expectedVersion:3}),'M6_BRANCH_STOCK_SWITCH_CONFLICT');
    await fail(()=>adjustStock(pool,owner,{storeId:store.id,variantId:v.id,
      operationId:id(),delta:2,reason:'restock'}),'M6_STOCK_CONFLICT');
    await fail(()=>enableBranchInventory(pool,outsider,{storeId:store.id,
      variantId:v.id,expectedVersion:3}),'M6_FORBIDDEN');
    assert.equal((await readBranchStock(pool,owner,{
      storeId:store.id,branchId:north.id})).balances[0]!.quantity,0);
    assert.equal((await readOfferSnapshot(pool,{storeId:store.id,
      branchId:north.id,variantId:v.id,at:mon})).available,false);
    const a={storeId:store.id,branchId:north.id,variantId:v.id,
      operationId:id(),delta:4,reason:'restock' as const};
    const first=await adjustBranchStock(pool,owner,a);
    assert.deepEqual([first.before,first.after],[0,4]);
    const replay=await adjustBranchStock(pool,owner,a);
    assert.equal(replay.replayed,true);
    assert.equal(replay.id,first.id);
    await fail(()=>adjustBranchStock(pool,owner,{...a,delta:3}),
      'M6_IDEMPOTENCY_CONFLICT');
    await adjustBranchStock(pool,owner,{...a,branchId:south.id,
      operationId:id(),delta:2});
    assert.equal((await readBranchStock(pool,owner,{storeId:store.id,
      branchId:south.id})).balances[0]!.quantity,2);
    await fail(()=>readBranchStock(pool,outsider,{storeId:store.id,
      branchId:north.id}),'M6_FORBIDDEN');
    await fail(()=>adjustBranchStock(pool,outsider,{...a,
      operationId:id()}),'M6_FORBIDDEN');
    await fail(()=>adjustBranchStock(pool,owner,{...a,
      branchId:id(),operationId:id()}),'M6_BRANCH_STOCK_INVALID');
    await fail(()=>adjustBranchStock(pool,owner,{...a,
      operationId:id(),delta:-3,reason:'restock'}),'M6_STOCK_REASON_INVALID');
    assert.equal((await readOfferSnapshot(pool,{storeId:store.id,
      branchId:north.id,variantId:v.id,at:mon})).stock_quantity,4);
    assert.equal((await readOfferSnapshot(pool,{storeId:store.id,
      branchId:south.id,variantId:v.id,at:mon})).stock_quantity,2);
    const listing=await readBranchStorefront(pool,{storeId:store.id,
      branchId:north.id,at:mon});
    assert.equal(listing.items[0]!.stockStatus,'in_stock');
    assert.ok(!JSON.stringify(listing).includes('quantity'));
    await adjustBranchStock(pool,owner,{...a,operationId:id(),
      delta:-4,reason:'waste'});
    assert.equal((await readBranchStorefront(pool,{storeId:store.id,
      branchId:north.id,at:mon})).items[0]!.stockStatus,'sold_out');
    assert.equal((await readBranchStorefront(pool,{storeId:store.id,
      branchId:south.id,at:mon})).items[0]!.stockStatus,'in_stock');
    const tasks=Array.from({length:8},()=>adjustBranchStock(pool,owner,{
      ...a,branchId:south.id,operationId:id(),delta:-1,reason:'correction'
    }));
    const completed=await Promise.allSettled(tasks);
    assert.equal(completed.filter(x=>x.status==='fulfilled').length,2);
    assert.equal((await readBranchStock(pool,owner,{
      storeId:store.id,branchId:south.id})).balances[0]!.quantity,0);
    await fail(()=>adjustBranchStock(pool,owner,{...a,branchId:south.id,
      operationId:id(),delta:-1,reason:'waste'}),'M6_STOCK_CONFLICT');
    const overview=await readMerchantOverview(pool,owner,store.id);
    assert.equal(overview.catalog.soldOutVariants,1);
    const other=await createStore(pool,outsider,{operationId:id(),
      slug:'branch-stock-other-'+id().slice(0,12),
      name:'Otro mercado',kind:'greengrocer'});
    await fail(()=>readBranchStock(pool,owner,{
      storeId:other.id,branchId:north.id}),'M6_FORBIDDEN');
    const ledger=await pool.query<{id:string}>(
      'SELECT id FROM tala_restaurants_v2.branch_stock_adjustments '+
      'WHERE store_id=$1::uuid LIMIT 1',[store.id]);
    assert.ok(ledger.rows[0]);
    await assert.rejects(pool.query(
      'DELETE FROM tala_restaurants_v2.branch_stock_adjustments '+
      'WHERE id=$1::uuid',[ledger.rows[0]!.id]),/IMMUTABLE/);
  }finally{await pool.end();}
});
