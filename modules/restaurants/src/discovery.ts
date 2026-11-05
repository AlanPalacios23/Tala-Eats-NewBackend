/** M6 isolated geo-local merchant discovery projection.
 * INTERNAL only until merchants have verified approval and customer gateway
 * authorization. Never treat LAB 'ready' as a commercial publishing approval.
 */
import type {Pool} from 'pg';
import {RestaurantError,member,field,integer,CITIES,KINDS,type City,type Kind} from './domain.js';
import {tx} from './db.js';

type DiscoveryRow={
  store_id:string,store_slug:string,store_name:string,kind:Kind,
  branch_id:string,branch_name:string,city:City,
  pickup_enabled:boolean,delivery_enabled:boolean,is_open:boolean
};
export async function discoverReadyBranches(pool:Pool,input:{
  city:City,kind?:Kind,search?:string,at?:Date,limit?:number,offset?:number
}){
  const city=member(input.city,CITIES,'M6_CITY_INVALID');
  const kind=input.kind===undefined?null:
    member(input.kind,KINDS,'M6_KIND_INVALID');
  const search=input.search===undefined?null:field(input.search,2,100);
  const at=input.at??new Date();
  if(!(at instanceof Date)||!Number.isFinite(at.getTime()))
    throw new RestaurantError('M6_TIME_INVALID');
  const limit=integer(input.limit??20,1,30,'M6_PAGE_INVALID');
  const offset=integer(input.offset??0,0,5000,'M6_PAGE_INVALID');
  return tx(pool,async c=>{
    const result=await c.query<DiscoveryRow>(
      'SELECT s.id AS store_id,s.slug AS store_slug,'+
      's.display_name AS store_name,s.kind,'+
      'b.id AS branch_id,b.branch_name,b.city,'+
      'b.pickup_enabled,b.delivery_enabled,'+
       '(tala_restaurants_v2.is_branch_scheduled_open(b.id,$4::timestamptz) '+
      'AND NOT EXISTS (SELECT 1 FROM tala_restaurants_v2.branch_closures x '+
      'WHERE x.branch_id=b.id AND x.store_id=s.id '+
      'AND x.cancelled_at IS NULL AND x.starts_at<=$4::timestamptz '+
      'AND x.ends_at>$4::timestamptz)) AS is_open '+
      'FROM tala_restaurants_v2.stores s '+
      'JOIN tala_restaurants_v2.branches b ON b.store_id=s.id '+
      "WHERE s.status='ready' AND b.is_active AND b.city=$1 "+
      'AND ($2::text IS NULL OR s.kind=$2::text) '+
      'AND ($3::text IS NULL OR position(lower($3::text) '+
      'in lower(s.display_name))>0) '+
      'AND EXISTS(SELECT 1 FROM tala_restaurants_v2.products p '+
      'JOIN tala_restaurants_v2.variants v ON v.product_id=p.id '+
      'AND v.store_id=p.store_id '+
      'LEFT JOIN tala_restaurants_v2.branch_variant_controls ctl '+
      'ON ctl.branch_id=b.id AND ctl.store_id=v.store_id '+
      'AND ctl.variant_id=v.id '+
      'LEFT JOIN tala_restaurants_v2.branch_stock bs '+
      'ON bs.store_id=v.store_id AND bs.branch_id=b.id '+
      'AND bs.variant_id=v.id '+
      'WHERE p.store_id=s.id AND p.is_active AND p.archived_at IS NULL '+
      'AND v.is_active AND coalesce(ctl.enabled,true) '+
      'AND (NOT v.track_stock OR (CASE WHEN v.branch_stock_enabled '+
      'THEN coalesce(bs.quantity,0) ELSE v.stock_quantity END)>0)) '+
      'ORDER BY s.display_name,s.id,b.branch_name,b.id LIMIT $5 OFFSET $6',
      [city,kind,search,at,limit+1,offset]);
    const items=result.rows.slice(0,limit).map(x=>Object.freeze({
      storeId:x.store_id,slug:x.store_slug,name:x.store_name,kind:x.kind,
      branchId:x.branch_id,branchName:x.branch_name,city:x.city,
      open:x.is_open,
      pickupAvailable:x.is_open&&x.pickup_enabled,
      deliveryAvailable:x.is_open&&x.delivery_enabled
    }));
    return Object.freeze({city,items:Object.freeze(items),
      nextOffset:result.rows.length>limit?offset+limit:null});
  },true);
}
