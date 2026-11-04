/** M7-only authenticated self-service geographic data erasure.
 * Deletes live address records, in-memory GPS snapshots and address-create
 * idempotency fingerprints; does not modify identity or other modules.
 * PostgreSQL WAL, database backups and pseudonymous audit are handled under
 * an external approved retention and recovery policy.
 */
import type {Pool} from 'pg';
import {uuid,type Actor} from './domain.js';
import {tx,ownerLock,audit} from './db.js';

export async function eraseMyLocationData(pool:Pool,actor:Actor){
 const owner=uuid(actor.actorId);
 return tx(pool,async c=>{
  // Same lock used for creates/updates and now all GPS snapshot mutations.
  await ownerLock(c,owner);
  const places=await c.query(
   'DELETE FROM tala_locations_v2.saved_places WHERE owner_id=$1::uuid',
   [owner]);
  const snapshots=await c.query(
   'DELETE FROM tala_locations_v2.location_snapshots WHERE owner_id=$1::uuid',
   [owner]);
  const receipts=await c.query(
   'DELETE FROM tala_locations_v2.idempotency_receipts '+
   "WHERE actor_id=$1::uuid AND action='place.create'",[owner]);
  // Audit carries only owner UUID + action; no exact location is retained.
  await audit(c,owner,'location.erase_all',owner);
  return Object.freeze({erased:true,placesDeleted:places.rowCount??0,
   snapshotsDeleted:snapshots.rowCount??0,
   receiptsDeleted:receipts.rowCount??0});
 });
}
