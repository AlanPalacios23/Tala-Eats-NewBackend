import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {createRestaurantsLabHttpServer} from '../src/http-lab.js';

const url=process.env.RESTAURANTS_CI_URL??'';
const enabled=/\/tala_restaurants_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID();
test('M6 HTTP LAB E2E: private identity, store, branch, hours and catalog contract',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:10});
  const owner=id(),stranger=id(),bearer='lab-'+id(),other='lab-'+id();
  const server=createRestaurantsLabHttpServer({
    pool,authenticate:async req=>
      req.headers.authorization==='Bearer '+bearer?{actorId:owner}:
      req.headers.authorization==='Bearer '+other?{actorId:stranger}:null
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  async function call(method:string,path:string,data?:unknown,auth?:string){
    const r=await fetch(base+path,{method,headers:{
      ...(data!==undefined?{'content-type':'application/json'}:{}),
      ...(auth?{authorization:'Bearer '+auth}:{})
    },...(data!==undefined?{body:JSON.stringify(data)}:{})});
    return {status:r.status,result:await r.json() as Record<string,unknown>,
      cache:r.headers.get('cache-control'),cors:r.headers.get('access-control-allow-origin')};
  }
  try{
    assert.equal((await call('GET','/v1/restaurants/health')).status,200);
    assert.equal((await call('GET','/v1/restaurants')).status,401);
    const created=await call('POST','/v1/restaurants',{
      operationId:id(),slug:'http-m6-'+id().slice(0,12),
      name:'Restaurante de Prueba',kind:'restaurant'
    },bearer);
    assert.equal(created.status,201);
    const storeId=String(created.result.id);
    assert.equal((await call('GET','/v1/restaurants/'+storeId,
      undefined,other)).status,403);
    assert.equal((await call('POST','/v1/restaurants',{
      operationId:id(),slug:'malicioso-'+id().slice(0,12),
      name:'Restaurante',kind:'restaurant',actorId:stranger
    },bearer)).status,400);
    const branch=await call('POST','/v1/restaurants/'+storeId+'/branches',{
      operationId:id(),name:'Sucursal Tala',
      address:'Centro de Tala, Jalisco',city:'tala',
      pickupEnabled:true,deliveryEnabled:true
    },bearer);
    assert.equal(branch.status,201);
    const branchId=String(branch.result.id);
    assert.equal((await call('PUT','/v1/restaurants/'+storeId+'/branches/'+
      branchId+'/hours',{expectedVersion:1,
      days:[{weekday:1,closed:false,openMinute:480,closeMinute:1320}]},
      bearer)).status,200);
    const p=await call('POST','/v1/restaurants/'+storeId+'/products',{
      operationId:id(),name:'Tacos de barbacoa',category:'Comidas'
    },bearer);
    assert.equal(p.status,201);
    const productId=String(p.result.id);
    const v=await call('POST','/v1/restaurants/'+storeId+'/products/'+
      productId+'/variants',{
        operationId:id(),label:'Orden de 4 tacos',priceCents:8900,
        stockQuantity:20,trackStock:true
      },bearer);
    assert.equal(v.status,201);
    const variantId=String(v.result.id);
    assert.equal((await call('POST','/v1/restaurants/'+storeId+'/status',{
      expectedVersion:1,status:'ready'},bearer)).status,200);
    const stock=await call('POST','/v1/restaurants/'+storeId+'/variants/'+
      variantId+'/stock',{operationId:id(),delta:-2,reason:'waste'},bearer);
    assert.equal(stock.status,200);
    assert.equal(stock.result.after,18);
    const catalog=await call('GET','/v1/restaurants/'+storeId+'/catalog',
      undefined,bearer);
    assert.equal((catalog.result.products as unknown[]).length,1);
    assert.equal((catalog.result.variants as unknown[]).length,1);
    assert.equal(catalog.cache,'private, no-store');
    assert.equal(catalog.cors,null);
    const exceptional='/v1/restaurants/'+storeId+'/branches/'+branchId+'/closures';
    const closure=await call('POST',exceptional,{
      operationId:id(),
      startsAt:'2026-11-02T17:00:00.000Z',
      endsAt:'2026-11-02T22:00:00.000Z',
      reason:'maintenance'
    },bearer);
    assert.equal(closure.status,201);
    const closureId=String(closure.result.id);
    assert.equal((await call('GET',exceptional,undefined,bearer)).status,200);
    assert.equal((await call('GET',exceptional,undefined,other)).status,403);
    assert.equal((await call('POST',exceptional,{
      operationId:id(),
      startsAt:'2026-11-02T18:00:00.000Z',
      endsAt:'2026-11-02T21:00:00.000Z',
      reason:'maintenance'
    },bearer)).status,409);
    assert.equal((await call('POST',
      exceptional+'/'+closureId+'/cancel',{},other)).status,403);
    const cancelled=await call('POST',
      exceptional+'/'+closureId+'/cancel',{},bearer);
    assert.equal(cancelled.status,200);
    assert.equal(cancelled.result.cancelled,true);
    assert.equal((await call('POST',
      exceptional+'/'+closureId+'/cancel',{},bearer)).result.cancelled,false);
    const storefront='/v1/restaurants/'+storeId+'/branches/'+branchId+'/storefront';
    const listing=await call('GET',storefront,undefined,other);
    assert.equal(listing.status,200);
    assert.equal((listing.result.items as unknown[]).length,1);
    assert.ok(!JSON.stringify(listing.result).includes(owner));
    assert.equal((await call('GET',storefront+'?limit=0',
      undefined,bearer)).status,400);
    const discover=await call('GET','/v1/restaurants/discover?city=tala',
      undefined,other);
    assert.equal(discover.status,200);
    assert.ok((discover.result.items as Array<{storeId:string}>)
      .some(x=>x.storeId===storeId));
    const overview=await call('GET','/v1/restaurants/'+storeId+'/overview',
      undefined,bearer);
    assert.equal(overview.status,200);
    assert.equal((overview.result.catalog as Record<string,unknown>).activeVariants,1);
    assert.equal((await call('GET','/v1/restaurants/'+storeId+'/overview',
      undefined,other)).status,403);
    const switched=await call('PUT',
      '/v1/restaurants/'+storeId+'/branches/'+branchId+
        '/variants/'+variantId+'/enabled',
      {expectedVersion:0,enabled:false},bearer);
    assert.equal(switched.status,200);
    assert.equal((await call('GET',storefront,
      undefined,other)).result.items instanceof Array,true);
    assert.equal(((await call('GET',storefront,
      undefined,other)).result.items as unknown[]).length,0);
    const newPhoto=await call('POST',
      '/v1/restaurants/'+storeId+'/products/'+productId+'/photos',
      {sha256:randomBytes(32).toString('hex'),contentType:'image/png'},bearer);
    assert.equal(newPhoto.status,201);
    const photoId=String(newPhoto.result.id);
    assert.equal((await call('POST',
      '/v1/restaurants/'+storeId+'/products/'+productId+
        '/photos/'+photoId+'/retire',{},other)).status,403);
    const retired=await call('POST',
      '/v1/restaurants/'+storeId+'/products/'+productId+
        '/photos/'+photoId+'/retire',{},bearer);
    assert.equal(retired.status,200);
    assert.equal(retired.result.retired,true);
    const otherStock=await call('POST','/v1/restaurants/'+storeId+'/variants/'+
      variantId+'/stock',{operationId:id(),delta:-1,reason:'waste'},other);
    assert.equal(otherStock.status,403);
    const denied=await call('POST','/v1/restaurants/'+storeId+'/products',{
      operationId:id(),name:'Intruso',category:'Comidas',ownerId:owner
    },bearer);
    assert.equal(denied.status,400);
    assert.equal((await call('GET','/v1/restaurants',undefined,bearer)).status,200);
    assert.equal(((await call('GET','/v1/restaurants',undefined,other)).result
      .stores as unknown[]).length,0);

    // End-to-end branch inventory routes: no payments, checkout or remote auth.
    const drained=await call('POST','/v1/restaurants/'+storeId+'/variants/'+
      variantId+'/stock',{operationId:id(),delta:-18,reason:'waste'},bearer);
    assert.equal(drained.status,200);
    assert.equal(drained.result.after,0);
    const switchMode=await call('POST','/v1/restaurants/'+storeId+'/variants/'+
      variantId+'/branch-inventory',{expectedVersion:3},bearer);
    assert.equal(switchMode.status,200);
    const inbound=await call('POST','/v1/restaurants/'+storeId+
      '/branches/'+branchId+'/variants/'+variantId+'/stock',
      {operationId:id(),delta:5,reason:'restock'},bearer);
    assert.equal(inbound.status,200);
    const second=await call('POST','/v1/restaurants/'+storeId+'/branches',{
      operationId:id(),name:'Sucursal Norte',
      address:'Avenida Norte 25, Tala',city:'tala',
      pickupEnabled:true,deliveryEnabled:false
    },bearer);
    assert.equal(second.status,201);
    const secondId=String(second.result.id);
    const privateBalance=await call('GET','/v1/restaurants/'+storeId+
      '/branches/'+branchId+'/stock',undefined,bearer);
    assert.equal(privateBalance.status,200);
    assert.equal((await call('GET','/v1/restaurants/'+storeId+
      '/branches/'+branchId+'/stock',undefined,other)).status,403);
    assert.equal((privateBalance.result.balances as unknown[]).length,1);
    const xfer='/v1/restaurants/'+storeId+'/stock/transfers';
    const transfer=await call('POST',xfer,{operationId:id(),
      fromBranchId:branchId,toBranchId:secondId,
      variantId,quantity:2},bearer);
    assert.equal(transfer.status,200);
    assert.equal(transfer.result.toAfter,2);
    assert.equal((await call('POST',xfer,{operationId:id(),
      fromBranchId:branchId,toBranchId:secondId,
      variantId,quantity:2},other)).status,403);
    const count=await call('POST','/v1/restaurants/'+storeId+
      '/branches/'+secondId+'/variants/'+variantId+'/count',{
        operationId:id(),expectedVersion:2,countedQuantity:1},bearer);
    assert.equal(count.status,200);
    assert.equal(count.result.delta,-1);
    const activity=await call('GET','/v1/restaurants/'+storeId+
      '/branches/'+secondId+'/stock/activity?limit=10',undefined,bearer);
    assert.equal(activity.status,200);
    assert.ok((activity.result.activity as unknown[]).length>=2);
    assert.equal((await call('GET','/v1/restaurants/'+storeId+
      '/branches/'+secondId+'/stock/activity?limit=0',undefined,bearer)).status,400);
    assert.equal((await call('GET','/v1/restaurants/'+storeId+
      '/branches/'+secondId+'/stock/activity',undefined,other)).status,403);
  }finally{
    await new Promise<void>((resolve,reject)=>server.close(err=>
      err?reject(err):resolve()));
    await pool.end();
  }
});
