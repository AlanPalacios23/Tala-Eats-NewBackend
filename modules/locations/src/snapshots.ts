/** M7 encrypted, expiring location snapshots; not continuous tracking history.
 * A host verifies foreground consent and authenticates the actor.
 */
import type {Pool} from 'pg';
import {LocationError,uuid,point,integer,member,type Actor,type Point} from './domain.js';
import {PrivateLocationCipher} from './crypto.js';
import {tx} from './db.js';
const PURPOSES=['foreground','active_delivery'] as const;
export type Purpose=typeof PURPOSES[number];
type Row={ciphertext:Buffer,nonce:Buffer,auth_tag:Buffer,updated_at:Date,expires_at:Date};
export async function putLocationSnapshot(pool:Pool,cipher:PrivateLocationCipher,
 actor:Actor,input:{purpose:Purpose,point:Point,accuracyMeters:number,consent:boolean}){
 const owner=uuid(actor.actorId),
  purpose=member(input.purpose,PURPOSES,'M7_PURPOSE_INVALID'),
  position=point(input.point),
  accuracy=integer(input.accuracyMeters,0,2000,'M7_ACCURACY_INVALID');
 if(input.consent!==true)throw new LocationError('M7_CONSENT_REQUIRED');
 const enc=cipher.encrypt(owner,'snapshot:'+purpose,{point:position,accuracyMeters:accuracy});
 return tx(pool,async c=>{
  const r=await c.query<{expires_at:Date}>(
   'INSERT INTO tala_locations_v2.location_snapshots '+
   '(owner_id,purpose,ciphertext,nonce,auth_tag,expires_at) '+
   'VALUES($1::uuid,$2,$3,$4,$5,clock_timestamp()+interval \'120 seconds\') '+
   'ON CONFLICT(owner_id,purpose) DO UPDATE SET '+
   'ciphertext=EXCLUDED.ciphertext,nonce=EXCLUDED.nonce,auth_tag=EXCLUDED.auth_tag,'+
   'updated_at=clock_timestamp(),'+
   "expires_at=clock_timestamp()+interval '120 seconds' RETURNING expires_at",
   [owner,purpose,enc.ciphertext,enc.nonce,enc.authTag]);
  return Object.freeze({expiresAt:r.rows[0]!.expires_at,purpose});
 });
}
export async function getLocationSnapshot(pool:Pool,cipher:PrivateLocationCipher,
 actor:Actor,purpose:Purpose){
 const owner=uuid(actor.actorId),p=member(purpose,PURPOSES,'M7_PURPOSE_INVALID');
 return tx(pool,async c=>{
  const r=await c.query<Row>(
   'SELECT ciphertext,nonce,auth_tag,updated_at,expires_at '+
   'FROM tala_locations_v2.location_snapshots '+
   'WHERE owner_id=$1::uuid AND purpose=$2 AND expires_at>clock_timestamp()',
   [owner,p]);
  if(!r.rows[0])return null;
  const data=cipher.decrypt<{point:Point,accuracyMeters:number}>(
   owner,'snapshot:'+p,{ciphertext:r.rows[0].ciphertext,
   nonce:r.rows[0].nonce,authTag:r.rows[0].auth_tag});
  return Object.freeze({purpose:p,point:data.point,accuracyMeters:data.accuracyMeters,
   updatedAt:r.rows[0].updated_at,expiresAt:r.rows[0].expires_at});
 },true);
}
export async function clearLocationSnapshot(pool:Pool,actor:Actor,purpose:Purpose){
 const owner=uuid(actor.actorId),p=member(purpose,PURPOSES,'M7_PURPOSE_INVALID');
 return tx(pool,async c=>{
  const r=await c.query('DELETE FROM tala_locations_v2.location_snapshots '+
   'WHERE owner_id=$1::uuid AND purpose=$2',[owner,p]);
  return Object.freeze({cleared:(r.rowCount??0)>0});
 });
}
/** Trusted maintenance worker only. Privacy TTL deletion is separately
 * scheduled by the host; this function does not create background jobs.
 */
export async function pruneExpiredSnapshots(pool:Pool,limit=500){
 const cap=integer(limit,1,1000,'M7_PAGE_INVALID');
 return tx(pool,async c=>{
  const r=await c.query('DELETE FROM tala_locations_v2.location_snapshots s '+
   'WHERE (s.owner_id,s.purpose) IN ('+
   'SELECT owner_id,purpose FROM tala_locations_v2.location_snapshots '+
   'WHERE expires_at<=clock_timestamp() ORDER BY expires_at '+
   'LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING s.owner_id',
   [cap]);
  return Object.freeze({purged:r.rowCount??0});
 });
}
