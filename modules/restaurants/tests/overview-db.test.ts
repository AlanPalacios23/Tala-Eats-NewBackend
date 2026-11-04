import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {RestaurantError} from '../src/domain.js';
import {createStore,createBranch,setBranchHours,changeStoreStatus} from '../src/stores.js';
import {createProduct,createVariant,archiveProduct} from '../src/catalog.js';
import {prepareProductPhoto,verifyProductPhoto} from '../src/media.js';
import {scheduleBranchClosure} from '../src/closures.js';
import {readMerchantOverview} from '../src/overview.js';
const url=process.env.RESTAURANTS_CI_URL??'';
const enabled=/\/tala_restaurants_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();

test('M6 merchant-only overview shows exact store-scoped operational counters without payments',
 {skip:!enabled,timeout:65000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:8});
  const owner={actorId:id()},outsider={actorId:id()};
  try{
    const store=await createStore(pool,owner,{
      operationId:id(),slug:'overview-'+id().slice(0,12),
      name:'Restaurante Operativo',kind:'restaurant'});
    const empty=await readMerchantOverview(pool,owner,store.id);
    assert.equal(empty.branches.total,0);
    assert.equal(empty.catalog.activeVariants,0);
    assert.equal(empty.photos.ready,0);
    await assert.rejects(()=>readMerchantOverview(pool,outsider,store.id),
      (e:unknown)=>e instanceof RestaurantError&&e.code==='M6_FORBIDDEN');
    const branch=await createBranch(pool,owner,{
      storeId:store.id,operationId:id(),name:'Tala',
      address:'Calle Primavera 8, Tala',city:'tala',
      pickupEnabled:true,deliveryEnabled:false});
    await setBranchHours(pool,owner,{storeId:store.id,branchId:branch.id,
      expectedVersion:1,days:[{weekday:1,closed:false,
        openMinute:540,closeMinute:1260}]});
    const product=await createProduct(pool,owner,{
      storeId:store.id,operationId:id(),name:'Tacos de pastor',category:'Comida'});
    await createVariant(pool,owner,{
      storeId:store.id,productId:product.id,operationId:id(),
      label:'Orden normal',priceCents:8900,stockQuantity:5,trackStock:true});
    await createVariant(pool,owner,{
      storeId:store.id,productId:product.id,operationId:id(),
      label:'Orden familiar',priceCents:14900,stockQuantity:0,trackStock:true});
    const photo=await prepareProductPhoto(pool,owner,{
      storeId:store.id,productId:product.id,
      sha256:randomBytes(32).toString('hex'),contentType:'image/png'});
    const pending=await readMerchantOverview(pool,owner,store.id);
    assert.deepEqual(pending.branches,{total:1,active:1});
    assert.equal(pending.catalog.activeProducts,1);
    assert.equal(pending.catalog.activeVariants,2);
    assert.equal(pending.catalog.inStockVariants,1);
    assert.equal(pending.catalog.soldOutVariants,1);
    assert.equal(pending.photos.pending,1);
    await verifyProductPhoto(pool,{storeId:store.id,photoId:photo.id,
      verify:async()=>true});
    await scheduleBranchClosure(pool,owner,{
      storeId:store.id,branchId:branch.id,operationId:id(),
      startsAt:'2030-12-24T16:00:00.000Z',
      endsAt:'2030-12-25T16:00:00.000Z',reason:'holiday'});
    const ready=await readMerchantOverview(pool,owner,store.id);
    assert.equal(ready.photos.ready,1);
    assert.equal(ready.photos.pending,0);
    assert.equal(ready.exceptionalClosuresUpcoming,1);
    const repr=JSON.stringify(ready);
    assert.ok(!repr.includes(owner.actorId));
    assert.ok(!repr.includes('price_cents'));
    assert.ok(!repr.includes('wallet'));
    await archiveProduct(pool,owner,{
      storeId:store.id,productId:product.id,expectedVersion:1});
    const after=await readMerchantOverview(pool,owner,store.id);
    assert.equal(after.catalog.activeProducts,0);
    assert.equal(after.catalog.archivedProducts,1);
    assert.equal(after.catalog.activeVariants,0);
    assert.equal(after.catalog.soldOutVariants,0);
    await changeStoreStatus(pool,owner,{
      storeId:store.id,expectedVersion:1,status:'paused'});
    assert.equal((await readMerchantOverview(pool,owner,store.id)).branches.total,1);
  }finally{await pool.end();}
});
