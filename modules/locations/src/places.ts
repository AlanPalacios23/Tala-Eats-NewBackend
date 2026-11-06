/** M7 private saved places. No direct table, call or FK to Users/Orders. */
import {randomUUID,randomBytes} from 'node:crypto';
import type {Pool} from 'pg';
import {LocationError,uuid,point,city,textField,integer,digest,assertKeys,
  type Actor,type Point} from './domain.js';
import {PrivateLocationCipher,type Encrypted} from './crypto.js';
import {tx,ownerLock,claim,complete,audit} from './db.js';

export type PlaceData={label:string,addressLine:string,city:string,
 point:Point,postalCode:string|null,reference:string};
type Row={id:string,owner_id:string,ciphertext:Buffer,nonce:Buffer,
 auth_tag:Buffer,is_default:boolean,version:number};
export function validatePlace(input:unknown):PlaceData{
 assertKeys(input,['label','addressLine','city','point','postalCode','reference']);
 const p=input as Record<string,unknown>;
 const postal=p.postalCode===null||p.postalCode===undefined?null:p.postalCode;
 if(postal!==null&&(typeof postal!=='string'||!/^[0-9]{5}$/.test(postal)))
  throw new LocationError('M7_POSTAL_CODE_INVALID');
 return Object.freeze({
  label:textField(p.label,1,50),
  addressLine:textField(p.addressLine,5,240),
  city:city(p.city),
  point:point(p.point),
  postalCode:postal as string|null,
  reference:p.reference===undefined?'':textField(p.reference,0,160)
 });
}
function decrypt(cipher:PrivateLocationCipher,owner:string,row:Row){
 return cipher.decrypt<PlaceData>(owner,row.id,{
  ciphertext:row.ciphertext,nonce:row.nonce,authTag:row.auth_tag});
}
export async function createPlace(pool:Pool,cipher:PrivateLocationCipher,
 actor:Actor,input:{operationId:string,data:PlaceData,isDefault?:boolean}){
 const owner=uuid(actor.actorId),op=uuid(input.operationId);
 const data=validatePlace(input.data);
 const selected=input.isDefault??false;
 if(typeof selected!=='boolean')throw new LocationError('M7_DEFAULT_INVALID');
 const fingerprint=digest({data,isDefault:selected});
 return tx(pool,async c=>{
  await ownerLock(c,owner);
  const previous=await claim(c,owner,op,'place.create',fingerprint);
  if(previous)return Object.freeze({id:previous,replayed:true});
  const count=await c.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_locations_v2.saved_places '+
   'WHERE owner_id=$1::uuid AND deleted_at IS NULL',[owner]);
  if((count.rows[0]?.n??0)>=15)throw new LocationError('M7_PLACE_LIMIT');
  const id=randomUUID(),enc=cipher.encrypt(owner,id,data);
  if(selected)await c.query('UPDATE tala_locations_v2.saved_places SET '+
   'is_default=false,version=version+1,updated_at=clock_timestamp() '+
   'WHERE owner_id=$1::uuid AND is_default AND deleted_at IS NULL',[owner]);
  await c.query('INSERT INTO tala_locations_v2.saved_places '+
   '(id,owner_id,ciphertext,nonce,auth_tag,is_default) '+
   'VALUES($1::uuid,$2::uuid,$3,$4,$5,$6)',
   [id,owner,enc.ciphertext,enc.nonce,enc.authTag,selected]);
  await audit(c,owner,'place.create',id);
  await complete(c,owner,op,id);
  return Object.freeze({id,replayed:false});
 });
}
export async function listPlaces(pool:Pool,cipher:PrivateLocationCipher,actor:Actor){
 const owner=uuid(actor.actorId);
 return tx(pool,async c=>{
  const r=await c.query<Row>('SELECT id,owner_id,ciphertext,nonce,auth_tag,'+
   'is_default,version FROM tala_locations_v2.saved_places '+
   'WHERE owner_id=$1::uuid AND deleted_at IS NULL '+
   'ORDER BY is_default DESC,created_at DESC,id DESC LIMIT 15',[owner]);
  return Object.freeze(r.rows.map(x=>Object.freeze({id:x.id,
   data:decrypt(cipher,owner,x),isDefault:x.is_default,version:x.version})));
 },true);
}
export async function updatePlace(pool:Pool,cipher:PrivateLocationCipher,
 actor:Actor,input:{placeId:string,expectedVersion:number,patch:Partial<PlaceData>}){
 const owner=uuid(actor.actorId),id=uuid(input.placeId),
  version=integer(input.expectedVersion,1,2147483646,'M7_VERSION_INVALID');
 assertKeys(input.patch,['label','addressLine','city','point','postalCode','reference']);
 if(Object.keys(input.patch).length===0)throw new LocationError('M7_REQUEST_INVALID');
 return tx(pool,async c=>{
  await ownerLock(c,owner);
  const row=await c.query<Row>('SELECT id,owner_id,ciphertext,nonce,auth_tag,'+
   'is_default,version FROM tala_locations_v2.saved_places '+
   'WHERE id=$1::uuid AND owner_id=$2::uuid AND deleted_at IS NULL FOR UPDATE',
   [id,owner]);
  const existing=row.rows[0];
  if(!existing)throw new LocationError('M7_PLACE_NOT_FOUND');
  if(existing.version!==version)throw new LocationError('M7_VERSION_CONFLICT');
  const data=validatePlace({...decrypt(cipher,owner,existing),...input.patch});
  const enc=cipher.encrypt(owner,id,data);
  const next=await c.query<{version:number}>('UPDATE tala_locations_v2.saved_places '+
   'SET ciphertext=$3,nonce=$4,auth_tag=$5,version=version+1,'+
   'updated_at=clock_timestamp() WHERE id=$1::uuid AND owner_id=$2::uuid '+
   'AND version=$6 RETURNING version',
   [id,owner,enc.ciphertext,enc.nonce,enc.authTag,version]);
  if(!next.rows[0])throw new LocationError('M7_VERSION_CONFLICT');
  await audit(c,owner,'place.update',id);
  return Object.freeze({id,version:next.rows[0].version});
 });
}
export async function setDefaultPlace(pool:Pool,actor:Actor,input:{
 placeId:string,expectedVersion:number
}){
 const owner=uuid(actor.actorId),id=uuid(input.placeId),
  version=integer(input.expectedVersion,1,2147483646,'M7_VERSION_INVALID');
 return tx(pool,async c=>{
  await ownerLock(c,owner);
  const current=await c.query<{version:number,is_default:boolean}>(
   'SELECT version,is_default FROM tala_locations_v2.saved_places '+
   'WHERE id=$1::uuid AND owner_id=$2::uuid AND deleted_at IS NULL FOR UPDATE',
   [id,owner]);
  if(!current.rows[0])throw new LocationError('M7_PLACE_NOT_FOUND');
  if(current.rows[0].version!==version)throw new LocationError('M7_VERSION_CONFLICT');
  if(current.rows[0].is_default)return Object.freeze({id,version,unchanged:true});
  await c.query('UPDATE tala_locations_v2.saved_places SET is_default=false,'+
   'version=version+1,updated_at=clock_timestamp() '+
   'WHERE owner_id=$1::uuid AND is_default AND deleted_at IS NULL',[owner]);
  const next=await c.query<{version:number}>(
   'UPDATE tala_locations_v2.saved_places SET is_default=true,'+
   'version=version+1,updated_at=clock_timestamp() '+
   'WHERE id=$1::uuid AND owner_id=$2::uuid AND version=$3 AND deleted_at IS NULL '+
   'RETURNING version',[id,owner,version]);
  if(!next.rows[0])throw new LocationError('M7_VERSION_CONFLICT');
  await audit(c,owner,'place.default',id);
  return Object.freeze({id,version:next.rows[0].version,unchanged:false});
 });
}
export async function deletePlace(pool:Pool,actor:Actor,input:{
 placeId:string,expectedVersion:number
}){
 const owner=uuid(actor.actorId),id=uuid(input.placeId),
  version=integer(input.expectedVersion,1,2147483646,'M7_VERSION_INVALID');
 return tx(pool,async c=>{
  await ownerLock(c,owner);
  const changed=await c.query('UPDATE tala_locations_v2.saved_places SET '+
   'ciphertext=$4,nonce=$5,auth_tag=$6,deleted_at=clock_timestamp(), '+
   'is_default=false,version=version+1,updated_at=clock_timestamp() '+
   'WHERE id=$1::uuid AND owner_id=$2::uuid AND version=$3 '+
   'AND deleted_at IS NULL RETURNING id',
   [id,owner,version,randomBytes(32),randomBytes(12),randomBytes(16)]);
  if(!changed.rowCount)throw new LocationError('M7_VERSION_CONFLICT');
  await audit(c,owner,'place.delete',id);
  return Object.freeze({id,deleted:true});
 });
}
