import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {RestaurantError} from '../src/domain.js';
import {createStore,createBranch,setBranchHours,changeStoreStatus,setStaffRole} from '../src/stores.js';
import {createProduct,createVariant,readOfferSnapshot} from '../src/catalog.js';
import {enableBranchInventory,adjustBranchStock,readBranchStock} from '../src/branch-stock.js';
import {transferBranchStock,countBranchStock,readBranchInventoryActivity} from '../src/inventory-operations.js';

const url=process.env.RESTAURANTS_CI_URL??'';
const enabled=/\/tala_restaurants_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
const fail=(f:()=>Promise<unknown>,code:string)=>assert.rejects(f,
 (e:unknown)=>e instanceof RestaurantError&&e.code===code);
const mon=new Date('2026-11-02T17:00:00Z');

test('M6 LAB6: physical transfer and cycle count stay isolated, idempotent and append-only',
 {skip:!enabled,timeout:120000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:16});
  const owner={actorId:id()},manager={actorId:id()},editor={actorId:id()},
    outsider={actorId:id()};
  try{
    const store=await createStore(pool,owner,{operationId:id(),
      slug:'lab6-'+id().slice(0,12),name:'Mercado de Tala',kind:'grocery'});
    await setStaffRole(pool,owner,{storeId:store.id,memberId:manager.actorId,role:'manager'});
    await setStaffRole(pool,owner,{storeId:store.id,memberId:editor.actorId,role:'editor'});
    const branchA=await createBranch(pool,owner,{storeId:store.id,operationId:id(),
      name:'Bodega Norte',address:'Mercado 10, Tala',city:'tala',
      pickupEnabled:true,deliveryEnabled:false});
    const branchB=await createBranch(pool,owner,{storeId:store.id,operationId:id(),
      name:'Bodega Sur',address:'Calle Sur 90, Tala',city:'tala',
      pickupEnabled:true,deliveryEnabled:false});
    for(const b of [branchA,branchB])
      await setBranchHours(pool,owner,{storeId:store.id,branchId:b.id,
        expectedVersion:1,days:[{weekday:1,closed:false,
          openMinute:540,closeMinute:1260}]});
    const product=await createProduct(pool,owner,{storeId:store.id,operationId:id(),
      name:'Harina de trigo',category:'Abarrotes'});
    const variant=await createVariant(pool,owner,{storeId:store.id,
      productId:product.id,operationId:id(),label:'1 kg',weightGrams:1000,
      priceCents:3400,trackStock:true,stockQuantity:0});
    await enableBranchInventory(pool,owner,{storeId:store.id,variantId:variant.id,
      expectedVersion:1});
    await fail(()=>changeStoreStatus(pool,owner,{storeId:store.id,
      expectedVersion:1,status:'ready'}),'M6_ONBOARDING_INCOMPLETE');
    await adjustBranchStock(pool,owner,{storeId:store.id,
      branchId:branchA.id,variantId:variant.id,operationId:id(),
      delta:9,reason:'restock'});
    await changeStoreStatus(pool,owner,{storeId:store.id,
      expectedVersion:1,status:'ready'});

    const transfer={storeId:store.id,fromBranchId:branchA.id,
      toBranchId:branchB.id,variantId:variant.id,operationId:id(),quantity:4};
    const first=await transferBranchStock(pool,manager,transfer);
    assert.deepEqual([first.fromBefore,first.fromAfter,first.toBefore,first.toAfter],
      [9,5,0,4]);
    const again=await transferBranchStock(pool,manager,transfer);
    assert.equal(again.replayed,true);
    assert.equal(again.id,first.id);
    await fail(()=>transferBranchStock(pool,manager,{...transfer,quantity:3}),
      'M6_IDEMPOTENCY_CONFLICT');
    await fail(()=>transferBranchStock(pool,editor,{...transfer,operationId:id()}),
      'M6_FORBIDDEN');
    await fail(()=>transferBranchStock(pool,outsider,{...transfer,operationId:id()}),
      'M6_FORBIDDEN');
    await fail(()=>transferBranchStock(pool,owner,{...transfer,operationId:id(),
      toBranchId:branchA.id}),'M6_TRANSFER_SAME_BRANCH');
    await fail(()=>transferBranchStock(pool,owner,{...transfer,operationId:id(),
      toBranchId:id()}),'M6_BRANCH_STOCK_INVALID');
    assert.equal((await readOfferSnapshot(pool,{storeId:store.id,
      branchId:branchB.id,variantId:variant.id,at:mon})).stock_quantity,4);
    const raced=await Promise.allSettled(Array.from({length:2},()=>transferBranchStock(
      pool,manager,{...transfer,operationId:id(),quantity:4})));
    assert.equal(raced.filter(x=>x.status==='fulfilled').length,1);
    assert.equal((await readBranchStock(pool,owner,{storeId:store.id,
      branchId:branchA.id})).balances[0]!.quantity,1);
    assert.equal((await readBranchStock(pool,owner,{storeId:store.id,
      branchId:branchB.id})).balances[0]!.quantity,8);

    const beforeCount=(await readBranchStock(pool,owner,{storeId:store.id,
      branchId:branchB.id})).balances[0]!;
    const stocktake={storeId:store.id,branchId:branchB.id,
      variantId:variant.id,operationId:id(),
      expectedVersion:beforeCount.version,countedQuantity:6};
    const counted=await countBranchStock(pool,manager,stocktake);
    assert.deepEqual([counted.before,counted.after,counted.delta],[8,6,-2]);
    assert.equal((await countBranchStock(pool,manager,stocktake)).replayed,true);
    await fail(()=>countBranchStock(pool,manager,{...stocktake,
      operationId:id(),countedQuantity:7}),'M6_VERSION_CONFLICT');
    await fail(()=>countBranchStock(pool,editor,{...stocktake,
      operationId:id()}),'M6_FORBIDDEN');
    const now=(await readBranchStock(pool,owner,{storeId:store.id,
      branchId:branchB.id})).balances[0]!;
    const confirm=await countBranchStock(pool,owner,{...stocktake,
      operationId:id(),expectedVersion:now.version,countedQuantity:6});
    assert.equal(confirm.delta,0);
    const activity=await readBranchInventoryActivity(pool,manager,{
      storeId:store.id,branchId:branchB.id});
    assert.ok(activity.activity.some(x=>x.kind==='count'&&x.delta===-2));
    assert.ok(activity.activity.some(x=>x.kind==='count'&&x.delta===0));
    assert.ok(activity.activity.some(x=>x.kind==='transfer_in'&&x.delta>0));
    await fail(()=>readBranchInventoryActivity(pool,outsider,{
      storeId:store.id,branchId:branchB.id}),'M6_FORBIDDEN');
    await fail(()=>readBranchInventoryActivity(pool,manager,{
      storeId:store.id,branchId:id()}),'M6_BRANCH_NOT_FOUND');
    await fail(()=>readBranchInventoryActivity(pool,manager,{
      storeId:store.id,branchId:branchA.id,limit:101}),'M6_PAGE_INVALID');
    for(const table of ['branch_stock_counts','branch_stock_transfers']){
      const r=await pool.query<{id:string}>(
        'SELECT id FROM tala_restaurants_v2.'+table+
        ' WHERE store_id=$1::uuid LIMIT 1',[store.id]);
      assert.ok(r.rows[0]);
      await assert.rejects(pool.query('DELETE FROM tala_restaurants_v2.'+table+
        ' WHERE id=$1::uuid',[r.rows[0]!.id]),/IMMUTABLE/);
    }
    const other=await createStore(pool,outsider,{operationId:id(),
      slug:'m6-other-'+id().slice(0,12),name:'Mercado Ajeno',kind:'grocery'});
    await fail(()=>transferBranchStock(pool,outsider,{...transfer,
      storeId:other.id,operationId:id()}),'M6_BRANCH_STOCK_INVALID');
    const finalA=(await readBranchStock(pool,owner,{storeId:store.id,
      branchId:branchA.id})).balances[0]!.quantity;
    const finalB=(await readBranchStock(pool,owner,{storeId:store.id,
      branchId:branchB.id})).balances[0]!.quantity;
    assert.equal(finalA+finalB,7); // 9 physical minus 2 counted discrepancy

    // Credit overflow must roll back the debit atomically (no lost inventory).
    const latestB=(await readBranchStock(pool,owner,{storeId:store.id,
      branchId:branchB.id})).balances[0]!;
    await countBranchStock(pool,manager,{...stocktake,operationId:id(),
      expectedVersion:latestB.version,countedQuantity:999999});
    await adjustBranchStock(pool,owner,{storeId:store.id,branchId:branchA.id,
      variantId:variant.id,operationId:id(),delta:2,reason:'restock'});
    await fail(()=>transferBranchStock(pool,owner,{...transfer,operationId:id(),
      quantity:2}),'M6_STOCK_CONFLICT');
    assert.equal((await readBranchStock(pool,owner,{storeId:store.id,
      branchId:branchA.id})).balances[0]!.quantity,3);
    assert.equal((await readBranchStock(pool,owner,{storeId:store.id,
      branchId:branchB.id})).balances[0]!.quantity,999999);
    const boundary=await transferBranchStock(pool,owner,{...transfer,
      operationId:id(),quantity:1});
    assert.equal(boundary.toAfter,1000000);

    // First physical count can initialize a missing per-branch row at version 0.
    const empty=await createBranch(pool,owner,{storeId:store.id,operationId:id(),
      name:'Bodega Central',address:'Calle Centro 200, Tala',city:'tala',
      pickupEnabled:true,deliveryEnabled:false});
    const zeroCount=await countBranchStock(pool,manager,{
      storeId:store.id,branchId:empty.id,variantId:variant.id,
      operationId:id(),expectedVersion:0,countedQuantity:0});
    assert.deepEqual([zeroCount.before,zeroCount.after,zeroCount.delta],[0,0,0]);
    await fail(()=>countBranchStock(pool,owner,{
      storeId:store.id,branchId:empty.id,variantId:variant.id,
      operationId:id(),expectedVersion:0,countedQuantity:1}),'M6_VERSION_CONFLICT');
  }finally{await pool.end();}
});
