/** M6 LAB5: merchant-controlled inventory scoped to each physical branch.
 * No order holds, payments, customer authorization or external module imports.
 */
import type {Pool} from 'pg';
import {RestaurantError,uuid,person,integer,digest,type Actor} from './domain.js';
import {tx,access,audit,claim,complete} from './db.js';

type Reason='restock'|'correction'|'waste';

/** One-way opt-in: the legacy store-wide balance must already be zero.
 * Existing stock must be reconciled through the legacy ledger first.
 */
export async function enableBranchInventory(pool:Pool,actor:Actor,input:{
 storeId:string,variantId:string,expectedVersion:number
}){
 const user=person(actor),store=uuid(input.storeId),variant=uuid(input.variantId);
 const version=integer(input.expectedVersion,1,2147483646,'M6_VERSION_INVALID');
 return tx(pool,async c=>{
   await access(c,store,user,['owner','manager'],true);
   const changed=await c.query<{version:number}>(
     'UPDATE tala_restaurants_v2.variants v SET '+
     'branch_stock_enabled=true,version=v.version+1,updated_at=clock_timestamp() '+
     'FROM tala_restaurants_v2.products p WHERE v.id=$1::uuid '+
     'AND v.store_id=$2::uuid AND v.version=$3 AND NOT v.branch_stock_enabled '+
     'AND v.track_stock AND v.stock_quantity=0 AND p.id=v.product_id '+
     'AND p.store_id=v.store_id AND p.archived_at IS NULL RETURNING v.version',
     [variant,store,version]);
   if(!changed.rows[0])
     throw new RestaurantError('M6_BRANCH_STOCK_SWITCH_CONFLICT');
   await audit(c,store,user,'stock.branch.enable',variant);
   return Object.freeze({storeId:store,variantId:variant,
     branchStockEnabled:true,version:changed.rows[0].version});
 });
}

/** Distinct ledger per branch and exact retry receipt. Serialized by store lock.
 * A missing branch balance starts at zero; never copies legacy/global inventory.
 */
export async function adjustBranchStock(pool:Pool,actor:Actor,input:{
 storeId:string,branchId:string,variantId:string,operationId:string,
 delta:number,reason:Reason
}){
 const user=person(actor),store=uuid(input.storeId),branch=uuid(input.branchId),
   variant=uuid(input.variantId),op=uuid(input.operationId);
 const delta=integer(input.delta,-1000000,1000000,'M6_STOCK_INVALID');
 if(delta===0)throw new RestaurantError('M6_STOCK_INVALID');
 if(!['restock','correction','waste'].includes(input.reason)||
    (input.reason==='restock'&&delta<0)||
    (input.reason==='waste'&&delta>0))
   throw new RestaurantError('M6_STOCK_REASON_INVALID');
 const fingerprint=digest({store,branch,variant,delta,reason:input.reason});
 return tx(pool,async c=>{
   await access(c,store,user,['owner','manager','editor'],true);
   const old=await claim(c,user,op,'stock.branch.adjust',fingerprint);
   if(old){
     const h=await c.query<{quantity_before:number,quantity_after:number}>(
       'SELECT quantity_before,quantity_after FROM '+
       'tala_restaurants_v2.branch_stock_adjustments '+
       'WHERE id=$1::uuid AND store_id=$2::uuid AND branch_id=$3::uuid '+
       'AND variant_id=$4::uuid',[old,store,branch,variant]);
     if(!h.rows[0])throw new RestaurantError('M6_RECEIPT_INVALID');
     return Object.freeze({id:old,replayed:true,before:h.rows[0].quantity_before,
       after:h.rows[0].quantity_after});
   }
   const eligible=await c.query(
     'SELECT v.id FROM tala_restaurants_v2.variants v '+
     'JOIN tala_restaurants_v2.products p ON p.id=v.product_id '+
     'AND p.store_id=v.store_id JOIN tala_restaurants_v2.branches b '+
     'ON b.store_id=v.store_id AND b.id=$2::uuid '+
     'WHERE v.id=$3::uuid AND v.store_id=$1::uuid '+
     'AND v.track_stock AND v.branch_stock_enabled '+
     'AND p.archived_at IS NULL',
     [store,branch,variant]);
   if(!eligible.rowCount)throw new RestaurantError('M6_BRANCH_STOCK_INVALID');
   await c.query(
     'INSERT INTO tala_restaurants_v2.branch_stock '+
     '(store_id,branch_id,variant_id) VALUES($1::uuid,$2::uuid,$3::uuid) '+
     'ON CONFLICT(branch_id,variant_id) DO NOTHING',
     [store,branch,variant]);
   const next=await c.query<{quantity:number}>(
     'UPDATE tala_restaurants_v2.branch_stock SET quantity=quantity+$4, '+
     'version=version+1,updated_at=clock_timestamp() '+
     'WHERE store_id=$1::uuid AND branch_id=$2::uuid AND variant_id=$3::uuid '+
     'AND quantity+$4 BETWEEN 0 AND 1000000 RETURNING quantity',
     [store,branch,variant,delta]);
   if(!next.rows[0])throw new RestaurantError('M6_STOCK_CONFLICT');
   const after=next.rows[0].quantity,before=after-delta;
   const history=await c.query<{id:string}>(
     'INSERT INTO tala_restaurants_v2.branch_stock_adjustments '+
     '(store_id,branch_id,variant_id,actor_id,operation_id,delta,'+
     'quantity_before,quantity_after,reason) '+
     'VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9) '+
     'RETURNING id',
     [store,branch,variant,user,op,delta,before,after,input.reason]);
   const id=history.rows[0]!.id;
   await audit(c,store,user,'stock.branch.adjust',variant);
   await complete(c,user,op,id);
   return Object.freeze({id,replayed:false,before,after});
 });
}

/** Private operational balance. Never exposed to a public storefront. */
export async function readBranchStock(pool:Pool,actor:Actor,input:{
 storeId:string,branchId:string
}){
 const user=person(actor),store=uuid(input.storeId),branch=uuid(input.branchId);
 return tx(pool,async c=>{
   await access(c,store,user);
   const belongs=await c.query('SELECT id FROM tala_restaurants_v2.branches '+
     'WHERE id=$1::uuid AND store_id=$2::uuid',[branch,store]);
   if(!belongs.rowCount)throw new RestaurantError('M6_BRANCH_NOT_FOUND');
   const r=await c.query<{variant_id:string,quantity:number,version:number}>(
     'SELECT v.id AS variant_id,coalesce(bs.quantity,0)::int AS quantity, '+
     'coalesce(bs.version,0)::int AS version '+
     'FROM tala_restaurants_v2.variants v '+
     'JOIN tala_restaurants_v2.products p ON p.id=v.product_id '+
     'AND p.store_id=v.store_id '+
     'LEFT JOIN tala_restaurants_v2.branch_stock bs '+
     'ON bs.store_id=v.store_id AND bs.variant_id=v.id '+
     'AND bs.branch_id=$2::uuid '+
     'WHERE v.store_id=$1::uuid AND v.branch_stock_enabled '+
     'AND p.archived_at IS NULL ORDER BY v.created_at DESC LIMIT 500',
     [store,branch]);
   return Object.freeze({storeId:store,branchId:branch,
     balances:Object.freeze(r.rows)});
 },true);
}
