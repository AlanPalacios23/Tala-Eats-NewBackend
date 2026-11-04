import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {RestaurantError} from '../src/domain.js';
import {createStore} from '../src/stores.js';
import {createProduct} from '../src/catalog.js';
import {prepareProductPhoto,verifyProductPhoto,
 selectPrimaryPhoto,listProductPhotos} from '../src/media.js';

const url=process.env.RESTAURANTS_CI_URL??'';
const enabled=/\/tala_restaurants_v2_test(?:$|\?)/.test(url);
const id=()=>randomUUID(),db=()=>new pg.Pool({connectionString:url,max:12});
const fail=(fn:()=>Promise<unknown>,code:string)=>assert.rejects(fn,
 (e:unknown)=>e instanceof RestaurantError&&e.code===code);
test('M6 photos: metadata only, safe object path, trusted verification and ownership',
 {skip:!enabled,timeout:65000},async()=>{
  const pool=db(),owner={actorId:id()},other={actorId:id()};
  try{
    const store=await createStore(pool,owner,{
      operationId:id(),slug:'imagenes-'+id().slice(0,12),
      name:'Restaurante Fotos',kind:'restaurant'});
    const product=await createProduct(pool,owner,{storeId:store.id,
      operationId:id(),name:'Hamburguesa premium',category:'Comida'});
    const sha=randomBytes(32).toString('hex');
    const data={storeId:store.id,productId:product.id,sha256:sha,
      contentType:'image/webp' as const};
    await fail(()=>prepareProductPhoto(pool,other,data),'M6_FORBIDDEN');
    await fail(()=>prepareProductPhoto(pool,owner,{...data,
      sha256:'bad_hash'}),'M6_PHOTO_HASH_INVALID');
    const pending=await prepareProductPhoto(pool,owner,data);
    assert.equal(pending.status,'pending');
    assert.match(pending.objectKey,/^m6\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+\.webp$/);
    assert.ok(!pending.objectKey.startsWith('https:'));
    const listed=await listProductPhotos(pool,owner,{
      storeId:store.id,productId:product.id});
    assert.equal(listed.length,1);
    assert.ok(!JSON.stringify(listed).includes('https://'));
    await fail(()=>selectPrimaryPhoto(pool,owner,{
      storeId:store.id,productId:product.id,photoId:pending.id}),
    'M6_PHOTO_NOT_READY');
    await fail(()=>verifyProductPhoto(pool,{
      storeId:store.id,photoId:pending.id,
      verify:async proof=>{
        assert.equal(proof.objectKey,pending.objectKey);
        assert.equal(proof.sha256,sha);
        assert.equal(proof.contentType,'image/webp');
        return false;
      }}),'M6_PHOTO_NOT_VERIFIED');
    assert.equal((await verifyProductPhoto(pool,{
      storeId:store.id,photoId:pending.id,verify:async()=>true
    })).status,'ready');
    assert.equal((await selectPrimaryPhoto(pool,owner,{
      storeId:store.id,productId:product.id,photoId:pending.id
    })).primary,true);
    assert.equal((await listProductPhotos(pool,owner,{
      storeId:store.id,productId:product.id}) as Array<{is_primary:boolean}>)
      .filter(x=>x.is_primary).length,1);
    await fail(()=>listProductPhotos(pool,other,{
      storeId:store.id,productId:product.id}),'M6_FORBIDDEN');
    await fail(()=>verifyProductPhoto(pool,{storeId:store.id,
      photoId:pending.id,verify:async()=>true}),'M6_PHOTO_STATUS_INVALID');
  }finally{await pool.end();}
});
test('M6 photo count limits: a ninth pending image is refused', 
 {skip:!enabled,timeout:65000},async()=>{
  const pool=db(),owner={actorId:id()};
  try{
    const store=await createStore(pool,owner,{
      operationId:id(),slug:'foto-cap-'+id().slice(0,12),
      name:'Restaurante Catálogo',kind:'restaurant'});
    const product=await createProduct(pool,owner,{storeId:store.id,
      operationId:id(),name:'Paquete familiar',category:'Platos'});
    for(let i=0;i<8;i++){
      const r=await prepareProductPhoto(pool,owner,{
        storeId:store.id,productId:product.id,
        sha256:randomBytes(32).toString('hex'),contentType:'image/jpeg'});
      assert.ok(r.id);
    }
    await fail(()=>prepareProductPhoto(pool,owner,{
      storeId:store.id,productId:product.id,
      sha256:randomBytes(32).toString('hex'),contentType:'image/jpeg'}),
      'M6_PHOTO_LIMIT');
  }finally{await pool.end();}
});
