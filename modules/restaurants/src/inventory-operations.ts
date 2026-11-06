/** M6 LAB6 — physical merchant inventory transfers and stock counts.
 * No order reservations, payments, couriers or external business module imports.
 */
import type {Pool,PoolClient} from 'pg';
import {RestaurantError,uuid,person,integer,digest,type Actor} from './domain.js';
import {tx,access,audit,claim,complete} from './db.js';

type Stock={quantity:number,version:number};
async function eligible(c:PoolClient,store:string,variant:string,branchIds:string[]){
  const r=await c.query<{id:string}>(
    'SELECT v.id FROM tala_restaurants_v2.variants v '+
    'JOIN tala_restaurants_v2.products p ON p.id=v.product_id AND p.store_id=v.store_id '+
    'WHERE v.store_id=$1::uuid AND v.id=$2::uuid AND v.branch_stock_enabled '+
    'AND v.track_stock AND p.archived_at IS NULL AND '+
    '(SELECT count(*)::int FROM tala_restaurants_v2.branches b '+
    'WHERE b.store_id=v.store_id AND b.id=ANY($3::uuid[]))=$4',
    [store,variant,branchIds,branchIds.length]);
  if(!r.rows[0])throw new RestaurantError('M6_BRANCH_STOCK_INVALID');
}
async function ensureBalance(c:PoolClient,store:string,branch:string,variant:string){
  await c.query('INSERT INTO tala_restaurants_v2.branch_stock '+
    '(store_id,branch_id,variant_id) VALUES($1::uuid,$2::uuid,$3::uuid) '+
    'ON CONFLICT(branch_id,variant_id) DO NOTHING',
    [store,branch,variant]);
}

/** Both sides commit together or not at all. The store lock also serializes
 * inventory adjustments and branch transfer/count actions across workers.
 */
export async function transferBranchStock(pool:Pool,actor:Actor,input:{
  storeId:string,fromBranchId:string,toBranchId:string,variantId:string,
  operationId:string,quantity:number
}){
  const user=person(actor),store=uuid(input.storeId),
    from=uuid(input.fromBranchId),to=uuid(input.toBranchId),
    variant=uuid(input.variantId),op=uuid(input.operationId);
  const qty=integer(input.quantity,1,1000000,'M6_STOCK_INVALID');
  if(from===to)throw new RestaurantError('M6_TRANSFER_SAME_BRANCH');
  const fingerprint=digest({store,from,to,variant,qty});
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager'],true);
    const previous=await claim(c,user,op,'stock.branch.transfer',fingerprint);
    if(previous){
      const h=await c.query<{source_before:number,source_after:number,
        destination_before:number,destination_after:number}>(
        'SELECT source_before,source_after,destination_before,destination_after '+
        'FROM tala_restaurants_v2.branch_stock_transfers WHERE id=$1::uuid '+
        'AND store_id=$2::uuid',[previous,store]);
      if(!h.rows[0])throw new RestaurantError('M6_RECEIPT_INVALID');
      return Object.freeze({id:previous,replayed:true,fromBefore:h.rows[0].source_before,
        fromAfter:h.rows[0].source_after,toBefore:h.rows[0].destination_before,
        toAfter:h.rows[0].destination_after});
    }
    await eligible(c,store,variant,[from,to]);
    // Deterministic lock ordering; safe even if callers transfer opposite ways.
    for(const branch of [from,to].sort())
      await ensureBalance(c,store,branch,variant);
    const debit=await c.query<Stock>(
      'UPDATE tala_restaurants_v2.branch_stock SET quantity=quantity-$4, '+
      'version=version+1,updated_at=clock_timestamp() '+
      'WHERE store_id=$1::uuid AND branch_id=$2::uuid AND variant_id=$3::uuid '+
      'AND quantity>=$4 RETURNING quantity,version',
      [store,from,variant,qty]);
    if(!debit.rows[0])throw new RestaurantError('M6_STOCK_CONFLICT');
    const credit=await c.query<Stock>(
      'UPDATE tala_restaurants_v2.branch_stock SET quantity=quantity+$4, '+
      'version=version+1,updated_at=clock_timestamp() '+
      'WHERE store_id=$1::uuid AND branch_id=$2::uuid AND variant_id=$3::uuid '+
      'AND quantity+$4<=1000000 RETURNING quantity,version',
      [store,to,variant,qty]);
    if(!credit.rows[0])throw new RestaurantError('M6_STOCK_CONFLICT');
    const fromAfter=debit.rows[0].quantity,toAfter=credit.rows[0].quantity;
    const history=await c.query<{id:string}>(
      'INSERT INTO tala_restaurants_v2.branch_stock_transfers '+
      '(store_id,from_branch_id,to_branch_id,variant_id,actor_id,operation_id,'+
      'quantity,source_before,source_after,destination_before,destination_after) '+
      'VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,'+
      '$7,$8,$9,$10,$11) RETURNING id',
      [store,from,to,variant,user,op,qty,fromAfter+qty,fromAfter,toAfter-qty,toAfter]);
    const id=history.rows[0]!.id;
    await audit(c,store,user,'stock.branch.transfer',variant);
    await complete(c,user,op,id);
    return Object.freeze({id,replayed:false,fromBefore:fromAfter+qty,
      fromAfter,toBefore:toAfter-qty,toAfter});
  });
}

/** Reconciliation against a physical count. Requires the exact inventory
 * version observed by the merchant; a stale count cannot overwrite a sale/
 * adjustment/transfer occurring since the count was started.
 * A zero-difference count is still audited, without a phantom stock delta.
 */
export async function countBranchStock(pool:Pool,actor:Actor,input:{
  storeId:string,branchId:string,variantId:string,operationId:string,
  expectedVersion:number,countedQuantity:number
}){
  const user=person(actor),store=uuid(input.storeId),branch=uuid(input.branchId),
    variant=uuid(input.variantId),op=uuid(input.operationId);
  const ver=integer(input.expectedVersion,0,2147483646,'M6_VERSION_INVALID'),
    counted=integer(input.countedQuantity,0,1000000,'M6_STOCK_INVALID');
  const fingerprint=digest({store,branch,variant,ver,counted});
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager'],true);
    const previous=await claim(c,user,op,'stock.branch.count',fingerprint);
    if(previous){
      const h=await c.query<{quantity_before:number,counted_quantity:number,delta:number}>(
        'SELECT quantity_before,counted_quantity,delta '+
        'FROM tala_restaurants_v2.branch_stock_counts '+
        'WHERE id=$1::uuid AND store_id=$2::uuid',[previous,store]);
      if(!h.rows[0])throw new RestaurantError('M6_RECEIPT_INVALID');
      return Object.freeze({id:previous,replayed:true,before:h.rows[0].quantity_before,
        after:h.rows[0].counted_quantity,delta:h.rows[0].delta});
    }
    await eligible(c,store,variant,[branch]);
    // Missing row has public version 0; materialize only inside the transaction.
    const old=await c.query<Stock>(
      'SELECT quantity,version FROM tala_restaurants_v2.branch_stock '+
      'WHERE store_id=$1::uuid AND branch_id=$2::uuid AND variant_id=$3::uuid '+
      'FOR UPDATE',[store,branch,variant]);
    if((old.rows[0]?.version??0)!==ver)
      throw new RestaurantError('M6_VERSION_CONFLICT');
    if(!old.rows[0])await ensureBalance(c,store,branch,variant);
    const changed=await c.query<Stock>(
      'UPDATE tala_restaurants_v2.branch_stock SET quantity=$4, '+
      'version=version+1,updated_at=clock_timestamp() '+
      'WHERE store_id=$1::uuid AND branch_id=$2::uuid AND variant_id=$3::uuid '+
      'AND version=$5 RETURNING quantity,version',
      [store,branch,variant,counted,old.rows[0]?.version??1]);
    if(!changed.rows[0])throw new RestaurantError('M6_VERSION_CONFLICT');
    const before=old.rows[0]?.quantity??0,delta=counted-before;
    const h=await c.query<{id:string}>(
      'INSERT INTO tala_restaurants_v2.branch_stock_counts '+
      '(store_id,branch_id,variant_id,actor_id,operation_id,'+
      'expected_version,quantity_before,counted_quantity,delta) '+
      'VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9) '+
      'RETURNING id',[store,branch,variant,user,op,ver,before,counted,delta]);
    const id=h.rows[0]!.id;
    await audit(c,store,user,'stock.branch.count',variant);
    await complete(c,user,op,id);
    return Object.freeze({id,replayed:false,before,after:counted,delta});
  });
}

export async function readBranchInventoryActivity(pool:Pool,actor:Actor,input:{
  storeId:string,branchId:string,limit?:number
}){
  const user=person(actor),store=uuid(input.storeId),branch=uuid(input.branchId);
  const limit=integer(input.limit??30,1,100,'M6_PAGE_INVALID');
  return tx(pool,async c=>{
    await access(c,store,user);
    const b=await c.query('SELECT id FROM tala_restaurants_v2.branches '+
      'WHERE id=$1::uuid AND store_id=$2::uuid',[branch,store]);
    if(!b.rowCount)throw new RestaurantError('M6_BRANCH_NOT_FOUND');
    const rows=await c.query<{id:string,kind:string,variant_id:string,delta:number,
      created_at:Date}>(
      'SELECT id,kind,variant_id,delta,created_at FROM ('+
      "SELECT id,'adjustment'::text AS kind,variant_id,delta,created_at "+
      'FROM tala_restaurants_v2.branch_stock_adjustments WHERE store_id=$1::uuid '+
      'AND branch_id=$2::uuid UNION ALL '+
      "SELECT id,'count'::text AS kind,variant_id,delta,created_at "+
      'FROM tala_restaurants_v2.branch_stock_counts WHERE store_id=$1::uuid '+
      'AND branch_id=$2::uuid UNION ALL '+
      "SELECT id,'transfer_out'::text AS kind,variant_id,-quantity AS delta,created_at "+
      'FROM tala_restaurants_v2.branch_stock_transfers WHERE store_id=$1::uuid '+
      'AND from_branch_id=$2::uuid UNION ALL '+
      "SELECT id,'transfer_in'::text AS kind,variant_id,quantity AS delta,created_at "+
      'FROM tala_restaurants_v2.branch_stock_transfers WHERE store_id=$1::uuid '+
      'AND to_branch_id=$2::uuid) movements '+
      'ORDER BY created_at DESC,id DESC LIMIT $3',
      [store,branch,limit]);
    return Object.freeze({storeId:store,branchId:branch,activity:Object.freeze(rows.rows)});
  },true);
}
