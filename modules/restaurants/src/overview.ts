/** M6 private operational overview. No orders, financial wallet or drivers.
 * Counts derive only from this module's isolated merchant schema.
 */
import type {Pool} from 'pg';
import {person,uuid,type Actor} from './domain.js';
import {tx,access} from './db.js';

export async function readMerchantOverview(pool:Pool,actor:Actor,storeId:string){
  const user=person(actor),store=uuid(storeId);
  return tx(pool,async c=>{
    await access(c,store,user);
    const result=await c.query<{
      branches:number,active_branches:number,products:number,archived_products:number,
      variants:number,in_stock_variants:number,sold_out_variants:number,
      pending_photos:number,ready_photos:number,upcoming_closures:number
    }>(
      'SELECT '+
      '(SELECT count(*)::int FROM tala_restaurants_v2.branches '+
      'WHERE store_id=$1::uuid) AS branches,'+
      '(SELECT count(*)::int FROM tala_restaurants_v2.branches '+
      'WHERE store_id=$1::uuid AND is_active) AS active_branches,'+
      '(SELECT count(*)::int FROM tala_restaurants_v2.products '+
      'WHERE store_id=$1::uuid AND is_active AND archived_at IS NULL) AS products,'+
      '(SELECT count(*)::int FROM tala_restaurants_v2.products '+
      'WHERE store_id=$1::uuid AND archived_at IS NOT NULL) AS archived_products,'+
      '(SELECT count(*)::int FROM tala_restaurants_v2.variants v '+
      'JOIN tala_restaurants_v2.products p ON p.id=v.product_id '+
      'AND p.store_id=v.store_id WHERE v.store_id=$1::uuid '+
      'AND p.is_active AND p.archived_at IS NULL AND v.is_active) AS variants,'+
      '(SELECT count(*)::int FROM tala_restaurants_v2.variants v '+
      'JOIN tala_restaurants_v2.products p ON p.id=v.product_id '+
      'AND p.store_id=v.store_id WHERE v.store_id=$1::uuid '+
      'AND p.is_active AND p.archived_at IS NULL AND v.is_active '+
      'AND (NOT v.track_stock OR (NOT v.branch_stock_enabled AND v.stock_quantity>0) '+
      'OR (v.branch_stock_enabled AND EXISTS(SELECT 1 FROM '+
      'tala_restaurants_v2.branch_stock bs WHERE bs.store_id=v.store_id '+
      'AND bs.variant_id=v.id AND bs.quantity>0))) AS in_stock_variants,'+
      '(SELECT count(*)::int FROM tala_restaurants_v2.variants v '+
      'JOIN tala_restaurants_v2.products p ON p.id=v.product_id '+
      'AND p.store_id=v.store_id WHERE v.store_id=$1::uuid '+
      'AND p.is_active AND p.archived_at IS NULL AND v.is_active '+
      'AND v.track_stock AND ((NOT v.branch_stock_enabled AND v.stock_quantity=0) '+
      'OR (v.branch_stock_enabled AND NOT EXISTS(SELECT 1 FROM '+
      'tala_restaurants_v2.branch_stock bs WHERE bs.store_id=v.store_id '+
      'AND bs.variant_id=v.id AND bs.quantity>0)))) AS sold_out_variants,'+
      '(SELECT count(*)::int FROM tala_restaurants_v2.product_photos '+
      "WHERE store_id=$1::uuid AND status='pending') AS pending_photos,"+
      '(SELECT count(*)::int FROM tala_restaurants_v2.product_photos '+
      "WHERE store_id=$1::uuid AND status='ready') AS ready_photos,"+
      '(SELECT count(*)::int FROM tala_restaurants_v2.branch_closures '+
      'WHERE store_id=$1::uuid AND cancelled_at IS NULL '+
      'AND ends_at>clock_timestamp()) AS upcoming_closures',
      [store]);
    const r=result.rows[0]!;
    return Object.freeze({
      storeId:store,
      branches:Object.freeze({total:r.branches,active:r.active_branches}),
      catalog:Object.freeze({activeProducts:r.products,
        archivedProducts:r.archived_products,
        activeVariants:r.variants,inStockVariants:r.in_stock_variants,
        soldOutVariants:r.sold_out_variants}),
      photos:Object.freeze({pending:r.pending_photos,ready:r.ready_photos}),
      exceptionalClosuresUpcoming:r.upcoming_closures
    });
  },true);
}
