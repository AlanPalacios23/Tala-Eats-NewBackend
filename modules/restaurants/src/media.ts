/** M6 photo metadata only. No arbitrary URL, no binary upload or LIVE storage.
 * Trusted storage adapter must verify object bytes/hash/type before readiness.
 */
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {RestaurantError,person,uuid,member,type Actor} from './domain.js';
import {tx,access,audit} from './db.js';
const MIMES=['image/webp','image/jpeg','image/png'] as const;
export type Mime=(typeof MIMES)[number];
export async function prepareProductPhoto(pool:Pool,actor:Actor,input:{
 storeId:string,productId:string,sha256:string,contentType:Mime
}){
  const user=person(actor),store=uuid(input.storeId),product=uuid(input.productId);
  if(typeof input.sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.sha256))
    throw new RestaurantError('M6_PHOTO_HASH_INVALID');
  const mime=member(input.contentType,MIMES,'M6_PHOTO_MIME_INVALID');
  const ext=mime==='image/webp'?'webp':mime==='image/png'?'png':'jpeg';
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager','editor'],true);
    const p=await c.query(
      'SELECT id FROM tala_restaurants_v2.products WHERE id=$1::uuid '+
      'AND store_id=$2::uuid AND archived_at IS NULL',[product,store]);
    if(!p.rowCount)throw new RestaurantError('M6_PRODUCT_NOT_FOUND');
    await c.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      ['m6.photos|'+store+'|'+product]);
    const count=await c.query<{n:number}>(
      'SELECT count(*)::int AS n FROM tala_restaurants_v2.product_photos '+
      "WHERE store_id=$1::uuid AND product_id=$2::uuid AND status<>'rejected'",
      [store,product]);
    if((count.rows[0]?.n??0)>=8)throw new RestaurantError('M6_PHOTO_LIMIT');
    const key='m6/'+store+'/'+product+'/'+randomUUID()+'.'+ext;
    const r=await c.query<{id:string}>(
      'INSERT INTO tala_restaurants_v2.product_photos('+
      'store_id,product_id,object_key,content_sha256,content_type) '+
      'VALUES($1::uuid,$2::uuid,$3,$4,$5) RETURNING id',
      [store,product,key,input.sha256,mime]);
    const photoId=r.rows[0]!.id;
    await audit(c,store,user,'photo.prepare',photoId);
    return {id:photoId,objectKey:key,status:'pending' as const};
  });
}
export type StorageProof={objectKey:string,sha256:string,contentType:Mime};
export type VerifyStoredImage=(proof:StorageProof)=>Promise<boolean>;
export async function verifyProductPhoto(pool:Pool,input:{
 storeId:string,photoId:string,verify:VerifyStoredImage
}){
  const store=uuid(input.storeId),id=uuid(input.photoId);
  if(typeof input.verify!=='function')
    throw new RestaurantError('M6_STORAGE_VERIFIER_REQUIRED');
  // Image object and metadata are accessed only through the trusted adapter.
  // No public API in M6 can set a photo ready without this proof.
  const info=await tx(pool,async c=>{
    const r=await c.query<{object_key:string,content_sha256:string,
      content_type:Mime,status:string}>(
      'SELECT object_key,content_sha256,content_type,status '+
      'FROM tala_restaurants_v2.product_photos WHERE id=$1::uuid '+
      'AND store_id=$2::uuid',[id,store]);
    if(!r.rows[0])throw new RestaurantError('M6_PHOTO_NOT_FOUND');
    return r.rows[0];
  },true);
  if(info.status!=='pending')throw new RestaurantError('M6_PHOTO_STATUS_INVALID');
  // The storage service MUST inspect actual bytes, compare SHA-256, content
  // type, dimensions and image decoding; the proof input is not client data.
  const proof:StorageProof={objectKey:info.object_key,sha256:info.content_sha256,
    contentType:info.content_type};
  const valid=await input.verify(proof);
  if(!valid)throw new RestaurantError('M6_PHOTO_NOT_VERIFIED');
  return tx(pool,async c=>{
    const r=await c.query(
      "UPDATE tala_restaurants_v2.product_photos SET status='ready' "+
      "WHERE id=$1::uuid AND store_id=$2::uuid AND status='pending' "+
      'RETURNING id',[id,store]);
    if(!r.rowCount)throw new RestaurantError('M6_PHOTO_STATUS_INVALID');
    return {id,status:'ready' as const};
  });
}
export async function selectPrimaryPhoto(pool:Pool,actor:Actor,input:{
 storeId:string,productId:string,photoId:string
}){
  const user=person(actor),store=uuid(input.storeId),
    product=uuid(input.productId),photo=uuid(input.photoId);
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager','editor'],true);
    const r=await c.query(
      "SELECT id FROM tala_restaurants_v2.product_photos "+
      "WHERE id=$1::uuid AND store_id=$2::uuid AND product_id=$3::uuid "+
      "AND status='ready' FOR UPDATE",[photo,store,product]);
    if(!r.rowCount)throw new RestaurantError('M6_PHOTO_NOT_READY');
    await c.query(
      'UPDATE tala_restaurants_v2.product_photos SET is_primary=false '+
      'WHERE store_id=$1::uuid AND product_id=$2::uuid AND is_primary',
      [store,product]);
    await c.query(
      'UPDATE tala_restaurants_v2.product_photos SET is_primary=true '+
      'WHERE id=$1::uuid',[photo]);
    await audit(c,store,user,'photo.primary',photo);
    return {photoId:photo,primary:true};
  });
}
export async function listProductPhotos(pool:Pool,actor:Actor,input:{
 storeId:string,productId:string
}){
  const user=person(actor),store=uuid(input.storeId),product=uuid(input.productId);
  return tx(pool,async c=>{
    await access(c,store,user);
    const r=await c.query(
      'SELECT id,object_key,content_type,status,is_primary,created_at '+
      'FROM tala_restaurants_v2.product_photos WHERE store_id=$1::uuid '+
      'AND product_id=$2::uuid ORDER BY created_at',[store,product]);
    return r.rows;
  },true);
}
