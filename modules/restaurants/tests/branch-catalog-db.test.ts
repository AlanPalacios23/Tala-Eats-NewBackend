import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {RestaurantError} from '../src/domain.js';
import {createStore,createBranch,setBranchHours,changeStoreStatus,
  setStaffRole} from '../src/stores.js';
import {createProduct,createVariant,readOfferSnapshot} from '../src/catalog.js';
import {setBranchVariantEnabled,readBranchStorefront} from '../src/branch-catalog.js';

const url=process.env.RESTAURANTS_CI_URL??'';
const enabled=/\/tala_restaurants_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
const fail=(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,
  (e:unknown)=>e instanceof RestaurantError&&e.code===code);
const mon=new Date('2026-11-02T17:00:00Z'); // 11 AM Tala local
test('M6 per-branch menu switches preserve tenancy, CAS, available stock and customer-safe projection',
 {skip:!enabled,timeout:90000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:15});
  const owner={actorId:id()},editor={actorId:id()},outsider={actorId:id()};
  try{
    const store=await createStore(pool,owner,{operationId:id(),
      slug:'menu-branch-'+id().slice(0,12),
      name:'Carnicería Centro',kind:'butcher'});
    await setStaffRole(pool,owner,{
      storeId:store.id,memberId:editor.actorId,role:'editor'});
    const b1=await createBranch(pool,owner,{storeId:store.id,operationId:id(),
      name:'Tala Centro',address:'Mercado 12, Tala',city:'tala',
      pickupEnabled:true,deliveryEnabled:false});
    const b2=await createBranch(pool,owner,{storeId:store.id,operationId:id(),
      name:'Tala Norte',address:'Avenida Norte 55, Tala',city:'tala',
      pickupEnabled:true,deliveryEnabled:true});
    for(const branch of [b1,b2]){
      await setBranchHours(pool,owner,{storeId:store.id,branchId:branch.id,
        expectedVersion:1,days:[
          {weekday:1,closed:false,openMinute:540,closeMinute:1260}
        ]});
    }
    const product=await createProduct(pool,owner,{storeId:store.id,
      operationId:id(),name:'Carne de res',category:'Carnes'});
    const half=await createVariant(pool,owner,{storeId:store.id,
      productId:product.id,operationId:id(),label:'500 g',weightGrams:500,
      priceCents:12500,stockQuantity:5,trackStock:true});
    const kilo=await createVariant(pool,owner,{storeId:store.id,
      productId:product.id,operationId:id(),label:'1 kg',weightGrams:1000,
      priceCents:24000,stockQuantity:0,trackStock:true});
    await changeStoreStatus(pool,owner,{storeId:store.id,
      expectedVersion:1,status:'ready'});
    const input={storeId:store.id,branchId:b1.id,at:mon};
    const listing=await readBranchStorefront(pool,input);
    assert.equal(listing.open,true);
    assert.equal(listing.pickupAvailable,true);
    assert.equal(listing.deliveryAvailable,false);
    assert.equal(listing.items.length,2);
    assert.ok(listing.items.some(x=>x.priceCents===12500&&x.available));
    assert.ok(listing.items.some(x=>x.priceCents===24000&&
      x.stockStatus==='sold_out'&&!x.available));
    assert.ok(!JSON.stringify(listing).includes(owner.actorId));
    assert.ok(!JSON.stringify(listing).includes('stock_quantity'));
    assert.ok(!JSON.stringify(listing).includes('object_key'));
    const page=await readBranchStorefront(pool,{...input,limit:1});
    assert.equal(page.items.length,1);
    assert.equal(page.nextOffset,1);
    const next=await readBranchStorefront(pool,{...input,offset:1,limit:1});
    assert.notEqual(page.items[0]!.variantId,next.items[0]!.variantId);
    assert.equal(next.nextOffset,null);
    assert.equal((await readBranchStorefront(pool,{
      ...input,category:'carnes'})).items.length,2);
    assert.equal((await readBranchStorefront(pool,{
      ...input,category:'Bebidas'})).items.length,0);
    await fail(()=>readBranchStorefront(pool,{...input,limit:501}),
      'M6_PAGE_INVALID');
    const hidden=await setBranchVariantEnabled(pool,editor,{
      storeId:store.id,branchId:b1.id,variantId:half.id,
      expectedVersion:0,enabled:false});
    assert.equal(hidden.version,1);
    assert.equal((await readBranchStorefront(pool,input)).items.length,1);
    assert.equal((await readBranchStorefront(pool,{...input,branchId:b2.id})).items.length,2);
    await fail(()=>readOfferSnapshot(pool,{
      storeId:store.id,branchId:b1.id,variantId:half.id
    }),'M6_OFFER_UNAVAILABLE');
    assert.equal((await readOfferSnapshot(pool,{
      storeId:store.id,branchId:b2.id,variantId:half.id
    })).available,true);
    await fail(()=>setBranchVariantEnabled(pool,outsider,{
      storeId:store.id,branchId:b1.id,variantId:half.id,
      expectedVersion:1,enabled:true
    }),'M6_FORBIDDEN');
    await fail(()=>setBranchVariantEnabled(pool,owner,{
      storeId:store.id,branchId:b1.id,variantId:half.id,
      expectedVersion:0,enabled:true
    }),'M6_VERSION_CONFLICT');
    await fail(()=>setBranchVariantEnabled(pool,owner,{
      storeId:store.id,branchId:b1.id,variantId:id(),
      expectedVersion:0,enabled:true
    }),'M6_BRANCH_VARIANT_INVALID');
    const sameVersion=Array.from({length:8},()=>setBranchVariantEnabled(pool,owner,{
      storeId:store.id,branchId:b1.id,variantId:half.id,
      expectedVersion:1,enabled:true
    }));
    const decisions=await Promise.allSettled(sameVersion);
    assert.equal(decisions.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(decisions.filter(x=>x.status==='rejected').length,7);
    assert.equal((await readBranchStorefront(pool,input)).items.length,2);
    const night=await readBranchStorefront(pool,{
      ...input,at:new Date('2026-11-03T05:00:00Z')});
    assert.equal(night.open,false);
    assert.equal(night.reason,'OUTSIDE_HOURS');
    assert.ok(night.items.every(x=>!x.available));
    assert.equal((await readBranchStorefront(pool,{...input,branchId:id()})
      .then(()=>false,()=>true)),true);
    const other=await createStore(pool,outsider,{operationId:id(),
      slug:'another-'+id().slice(0,12),
      name:'Otra Carnicería',kind:'butcher'});
    await fail(()=>setBranchVariantEnabled(pool,owner,{
      storeId:other.id,branchId:b1.id,variantId:half.id,
      expectedVersion:0,enabled:false
    }),'M6_FORBIDDEN');
    assert.ok(kilo.id);
  }finally{await pool.end();}
});
