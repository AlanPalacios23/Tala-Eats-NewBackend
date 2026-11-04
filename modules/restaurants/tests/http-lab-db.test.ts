import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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
  }finally{
    await new Promise<void>((resolve,reject)=>server.close(err=>
      err?reject(err):resolve()));
    await pool.end();
  }
});
