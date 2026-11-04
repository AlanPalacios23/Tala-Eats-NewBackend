import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {RestaurantError} from '../src/domain.js';
import {createStore,createBranch,setBranchHours,changeStoreStatus,
 setStaffRole} from '../src/stores.js';
import {createProduct,createVariant,updateProduct,archiveProduct,setVariantPrice,
 adjustStock,readCatalog,readOfferSnapshot} from '../src/catalog.js';

const url=process.env.RESTAURANTS_CI_URL??'';
const enabled=/\/tala_restaurants_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID(),db=()=>new pg.Pool({connectionString:url,max:22});
const fail=(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,
  (e:unknown)=>e instanceof RestaurantError&&e.code===code);
async function storeFor(pool:pg.Pool,owner:{actorId:string},name:string){
  return createStore(pool,owner,{operationId:id(),
    slug:name+'-'+id().slice(0,12),name:'Mercado '+name,kind:'greengrocer'});
}
test('M6 fixed-weight product variants: exact MXN cents, idempotency, price CAS, archive',
 {skip:!enabled,timeout:80000},async()=>{
  const pool=db(),owner={actorId:id()},editor={actorId:id()},outsider={actorId:id()};
  try{
    const store=await storeFor(pool,owner,'verduras');
    await setStaffRole(pool,owner,{storeId:store.id,memberId:editor.actorId,role:'editor'});
    const original={storeId:store.id,operationId:id(),
      name:'Jitomate saladet',description:'Producto fresco',category:'Verduras'};
    const product=await createProduct(pool,editor,original);
    assert.equal((await createProduct(pool,editor,original)).id,product.id);
    await fail(()=>createProduct(pool,editor,{
      ...original,name:'El otro producto'}),'M6_IDEMPOTENCY_CONFLICT');
    await fail(()=>createProduct(pool,outsider,{...original,
      operationId:id()}),'M6_FORBIDDEN');
    const half={storeId:store.id,productId:product.id,operationId:id(),
      label:'500 g',weightGrams:500,priceCents:3500,
      stockQuantity:8,trackStock:true};
    const v500=await createVariant(pool,editor,half);
    assert.equal((await createVariant(pool,editor,half)).id,v500.id);
    const v1k=await createVariant(pool,editor,{...half,operationId:id(),
      label:'1 kg',weightGrams:1000,priceCents:6500});
    assert.notEqual(v1k.id,v500.id);
    await fail(()=>createVariant(pool,editor,{...half,operationId:id(),
      priceCents:35.75}),'M6_PRICE_INVALID');
    await fail(()=>createVariant(pool,editor,{...half,operationId:id(),
      stockQuantity:-1}),'M6_STOCK_INVALID');
    const catalog=await readCatalog(pool,editor,store.id);
    assert.equal(catalog.products.length,1);
    assert.equal(catalog.variants.length,2);
    assert.deepEqual(catalog.variants.map(x=>Number(x.price_cents)).sort(),
      [3500,6500]);
    await fail(()=>readCatalog(pool,outsider,store.id),'M6_FORBIDDEN');
    const priced=await setVariantPrice(pool,editor,{
      storeId:store.id,variantId:v500.id,expectedVersion:1,priceCents:3900});
    assert.equal(priced.version,2);
    await fail(()=>setVariantPrice(pool,editor,{
      storeId:store.id,variantId:v500.id,expectedVersion:1,priceCents:4000}),
    'M6_VERSION_CONFLICT');
    const changed=await updateProduct(pool,editor,{
      storeId:store.id,productId:product.id,expectedVersion:1,
      description:'Producido localmente'});
    assert.equal(changed.version,2);
    await fail(()=>archiveProduct(pool,editor,{
      storeId:store.id,productId:product.id,expectedVersion:2}),
    'M6_FORBIDDEN');
    await archiveProduct(pool,owner,{
      storeId:store.id,productId:product.id,expectedVersion:2});
    await fail(()=>setVariantPrice(pool,editor,{
      storeId:store.id,variantId:v500.id,expectedVersion:2,priceCents:4000}),
    'M6_VERSION_CONFLICT');
  }finally{await pool.end();}
});
test('M6 stock ledger: idempotent operation, negative prevention and 18-way concurrency',
 {skip:!enabled,timeout:100000},async()=>{
  const pool=db(),owner={actorId:id()},other={actorId:id()};
  try{
    const store=await storeFor(pool,owner,'stock');
    const product=await createProduct(pool,owner,{storeId:store.id,
      operationId:id(),name:'Papa blanca',category:'Verduras'});
    const variant=await createVariant(pool,owner,{storeId:store.id,
      productId:product.id,operationId:id(),label:'1 kg',
      weightGrams:1000,priceCents:4900,stockQuantity:10,trackStock:true});
    const input={storeId:store.id,variantId:variant.id,operationId:id(),
      delta:-3,reason:'waste' as const};
    const first=await adjustStock(pool,owner,input);
    assert.deepEqual([first.before,first.after],[10,7]);
    const again=await adjustStock(pool,owner,input);
    assert.equal(again.replayed,true);
    assert.equal(again.id,first.id);
    assert.equal(again.after,7);
    await fail(()=>adjustStock(pool,owner,{...input,delta:-2}),
      'M6_IDEMPOTENCY_CONFLICT');
    await fail(()=>adjustStock(pool,other,{...input,operationId:id()}),
      'M6_FORBIDDEN');
    await fail(()=>adjustStock(pool,owner,{...input,operationId:id(),delta:-8}),
      'M6_STOCK_CONFLICT');
    const adjusts=Array.from({length:18},(_,i)=>
      adjustStock(pool,owner,{storeId:store.id,variantId:variant.id,
        operationId:id(),delta:1,reason:i%2===0?'restock':'correction'}));
    const completed=await Promise.all(adjusts);
    assert.equal(completed.filter(x=>!x.replayed).length,18);
    const catalog=await readCatalog(pool,owner,store.id);
    assert.equal(catalog.variants[0]?.stock_quantity,25);
    const rows=await pool.query(
      'SELECT count(*)::int AS n, sum(delta)::int AS total '+
      'FROM tala_restaurants_v2.stock_adjustments WHERE store_id=$1',[store.id]);
    assert.equal(rows.rows[0]?.n,19);
    assert.equal(rows.rows[0]?.total,15);
    await assert.rejects(pool.query(
      'UPDATE tala_restaurants_v2.audit SET action=$1 WHERE store_id=$2',
      ['hack.change',store.id]),
      (e:unknown)=>e instanceof Error&&e.message.includes('RESTAURANTS_AUDIT_IMMUTABLE'));
  }finally{await pool.end();}
});
test('M6 offer snapshot is available only for ready store and correct branch/variant tenant',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=db(),owner={actorId:id()},outsider={actorId:id()};
  try{
    const store=await storeFor(pool,owner,'offers');
    const branch=await createBranch(pool,owner,{storeId:store.id,
      operationId:id(),name:'Punto 1',address:'Zona Centro de Tala',
      city:'tala',pickupEnabled:true,deliveryEnabled:true});
    const product=await createProduct(pool,owner,{storeId:store.id,
      operationId:id(),name:'Zanahoria',category:'Verduras'});
    const variant=await createVariant(pool,owner,{storeId:store.id,
      productId:product.id,operationId:id(),label:'500 g',
      priceCents:2500,weightGrams:500,stockQuantity:8,trackStock:true});
    await fail(()=>readOfferSnapshot(pool,{
      storeId:store.id,branchId:branch.id,variantId:variant.id}),
    'M6_OFFER_UNAVAILABLE');
    await setBranchHours(pool,owner,{storeId:store.id,branchId:branch.id,
      expectedVersion:1,days:[{weekday:1,closed:false,openMinute:540,closeMinute:1200}]});
    await changeStoreStatus(pool,owner,{storeId:store.id,
      expectedVersion:1,status:'ready'});
    const ready=await readOfferSnapshot(pool,{storeId:store.id,
      branchId:branch.id,variantId:variant.id});
    assert.equal(ready.currency,'MXN');
    assert.equal(Number(ready.price_cents),2500);
    assert.equal(ready.weight_grams,500);
    assert.equal(ready.available,true);
    const second=await storeFor(pool,outsider,'different');
    await fail(()=>readOfferSnapshot(pool,{storeId:second.id,
      branchId:branch.id,variantId:variant.id}),'M6_OFFER_UNAVAILABLE');
    await changeStoreStatus(pool,owner,{storeId:store.id,
      expectedVersion:2,status:'paused'});
    await fail(()=>readOfferSnapshot(pool,{storeId:store.id,
      branchId:branch.id,variantId:variant.id}),'M6_OFFER_UNAVAILABLE');
  }finally{await pool.end();}
});
