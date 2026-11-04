/** M6 per-branch menu switches and safe storefront read contract.
 * No orders, reservations, checkouts, payment or courier logic.
 * A host/gateway must authorize public storefront discovery separately.
 */
import type {Pool} from 'pg';
import {RestaurantError,uuid,person,integer,field,type Actor} from './domain.js';
import {tx,access,audit} from './db.js';

export async function setBranchVariantEnabled(pool:Pool,actor:Actor,input:{
  storeId:string,branchId:string,variantId:string,
  expectedVersion:number,enabled:boolean
}){
  const user=person(actor),store=uuid(input.storeId),
    branch=uuid(input.branchId),variant=uuid(input.variantId);
  const version=integer(input.expectedVersion,0,2147483646,'M6_VERSION_INVALID');
  if(typeof input.enabled!=='boolean')
    throw new RestaurantError('M6_ACTIVE_INVALID');
  return tx(pool,async c=>{
    // Serializes all per-store menu decisions even under multiple managers.
    await access(c,store,user,['owner','manager','editor'],true);
    const eligible=await c.query(
      'SELECT v.id FROM tala_restaurants_v2.variants v '+
      'JOIN tala_restaurants_v2.products p ON p.id=v.product_id '+
      'AND p.store_id=v.store_id '+
      'JOIN tala_restaurants_v2.branches b ON b.store_id=v.store_id '+
      'AND b.id=$2::uuid '+
      'WHERE v.store_id=$1::uuid AND v.id=$3::uuid '+
      'AND p.archived_at IS NULL',
      [store,branch,variant]);
    if(!eligible.rowCount)throw new RestaurantError('M6_BRANCH_VARIANT_INVALID');
    let newVersion:number;
    if(version===0){
      const r=await c.query<{version:number}>(
        'INSERT INTO tala_restaurants_v2.branch_variant_controls '+
        '(store_id,branch_id,variant_id,enabled) '+
        'VALUES($1::uuid,$2::uuid,$3::uuid,$4) '+
        'ON CONFLICT(branch_id,variant_id) DO NOTHING RETURNING version',
        [store,branch,variant,input.enabled]);
      if(!r.rows[0])throw new RestaurantError('M6_VERSION_CONFLICT');
      newVersion=r.rows[0].version;
    }else{
      const r=await c.query<{version:number}>(
        'UPDATE tala_restaurants_v2.branch_variant_controls SET '+
        'enabled=$4,version=version+1,updated_at=clock_timestamp() '+
        'WHERE store_id=$1::uuid AND branch_id=$2::uuid '+
        'AND variant_id=$3::uuid AND version=$5 RETURNING version',
        [store,branch,variant,input.enabled,version]);
      if(!r.rows[0])throw new RestaurantError('M6_VERSION_CONFLICT');
      newVersion=r.rows[0].version;
    }
    await audit(c,store,user,'branch.variant.enabled',variant);
    return Object.freeze({storeId:store,branchId:branch,variantId:variant,
      enabled:input.enabled,version:newVersion});
  });
}

type BranchRow={
  display_name:string,kind:string,branch_name:string,city:string,
  pickup_enabled:boolean,delivery_enabled:boolean,is_active:boolean,
  closed:boolean,exception_closed:boolean,open_minute:number|null,
  close_minute:number|null,local_minute:number
};
type ListingRow={
  variant_id:string,product_id:string,product_name:string,
  description:string,category:string,variant_label:string,
  weight_grams:number|null,price_cents:string,
  track_stock:boolean,stock_quantity:number,photo_id:string|null
};

/** Read-only storefront projection for a trusted future customer gateway.
 * Never exposes owner/staff identifiers, internal audit, exact stock or object storage keys.
 */
export async function readBranchStorefront(pool:Pool,input:{
  storeId:string,branchId:string,at?:Date,
  limit?:number,offset?:number,category?:string
}){
  const store=uuid(input.storeId),branch=uuid(input.branchId);
  const at=input.at??new Date();
  if(!(at instanceof Date)||!Number.isFinite(at.getTime()))
    throw new RestaurantError('M6_TIME_INVALID');
  const limit=integer(input.limit??20,1,50,'M6_PAGE_INVALID');
  const offset=integer(input.offset??0,0,5000,'M6_PAGE_INVALID');
  const category=input.category===undefined?null:field(input.category,2,60);
  return tx(pool,async c=>{
    const b=await c.query<BranchRow>(
      'SELECT s.display_name,s.kind,b.branch_name,b.city,'+
      'b.pickup_enabled,b.delivery_enabled,b.is_active,'+
      'coalesce(h.closed,true) AS closed,h.open_minute,h.close_minute,'+
      '((extract(hour from ($3::timestamptz AT TIME ZONE '+
      "'America/Mexico_City'))::int*60)+"+
      '(extract(minute from ($3::timestamptz AT TIME ZONE '+
      "'America/Mexico_City'))::int)) AS local_minute,"+
      'EXISTS(SELECT 1 FROM tala_restaurants_v2.branch_closures e '+
      'WHERE e.branch_id=b.id AND e.store_id=s.id AND e.cancelled_at IS NULL '+
      'AND e.starts_at<=$3::timestamptz '+
      'AND e.ends_at>$3::timestamptz) AS exception_closed '+
      'FROM tala_restaurants_v2.stores s '+
      'JOIN tala_restaurants_v2.branches b ON b.store_id=s.id '+
      'LEFT JOIN tala_restaurants_v2.hours h ON h.branch_id=b.id '+
      'AND h.weekday=extract(dow FROM ($3::timestamptz AT TIME ZONE '+
      "'America/Mexico_City'))::int "+
      "WHERE s.id=$1::uuid AND b.id=$2::uuid AND s.status='ready'",
      [store,branch,at]);
    const row=b.rows[0];
    if(!row)throw new RestaurantError('M6_STOREFRONT_UNAVAILABLE');
    const scheduled=!row.closed&&row.open_minute!==null&&
      row.close_minute!==null&&row.local_minute>=row.open_minute&&
      row.local_minute<row.close_minute;
    const isOpen=row.is_active&&scheduled&&!row.exception_closed;
    const reason=!row.is_active?'BRANCH_PAUSED':
      row.exception_closed?'EXCEPTIONAL_CLOSURE':
      !scheduled?'OUTSIDE_HOURS':'OPEN';
    const products=await c.query<ListingRow>(
      'SELECT v.id AS variant_id,p.id AS product_id,p.name AS product_name,'+
      'p.description,p.category,v.label AS variant_label,v.weight_grams,'+
      'v.price_cents,v.track_stock,'+
      'CASE WHEN v.branch_stock_enabled THEN coalesce(bs.quantity,0) '+
      'ELSE v.stock_quantity END AS stock_quantity,photo.id AS photo_id '+
      'FROM tala_restaurants_v2.variants v '+
      'JOIN tala_restaurants_v2.products p ON p.id=v.product_id '+
      'AND p.store_id=v.store_id '+
      'LEFT JOIN tala_restaurants_v2.branch_variant_controls ctrl '+
      'ON ctrl.variant_id=v.id AND ctrl.branch_id=$2::uuid '+
      'AND ctrl.store_id=v.store_id '+
      'LEFT JOIN tala_restaurants_v2.branch_stock bs '+
      'ON bs.store_id=v.store_id AND bs.branch_id=$2::uuid '+
      'AND bs.variant_id=v.id '+
      'LEFT JOIN LATERAL (SELECT ph.id FROM tala_restaurants_v2.product_photos ph '+
      "WHERE ph.product_id=p.id AND ph.store_id=p.store_id "+
      "AND ph.status='ready' AND ph.is_primary LIMIT 1) photo ON true "+
      'WHERE v.store_id=$1::uuid AND p.is_active AND p.archived_at IS NULL '+
      'AND v.is_active AND coalesce(ctrl.enabled,true) '+
      'AND ($5::text IS NULL OR lower(p.category)=lower($5::text)) '+
      'ORDER BY v.created_at DESC,v.id DESC LIMIT $3 OFFSET $4',
      [store,branch,limit+1,offset,category]);
    const current=products.rows.slice(0,limit);
    const items=current.map(x=>Object.freeze({
      productId:x.product_id,variantId:x.variant_id,
      name:x.product_name,description:x.description,category:x.category,
      label:x.variant_label,weightGrams:x.weight_grams,
      priceCents:Number(x.price_cents),currency:'MXN' as const,
      primaryPhotoId:x.photo_id,
      stockStatus:!x.track_stock||x.stock_quantity>0?
        'in_stock' as const:'sold_out' as const,
      available:isOpen&&(!x.track_stock||x.stock_quantity>0)
    }));
    return Object.freeze({
      storeId:store,branchId:branch,storeName:row.display_name,
      kind:row.kind,branchName:row.branch_name,city:row.city,
      timeZone:'America/Mexico_City',
      open:isOpen,reason,
      pickupAvailable:isOpen&&row.pickup_enabled,
      deliveryAvailable:isOpen&&row.delivery_enabled,
      items:Object.freeze(items),
      nextOffset:products.rows.length>limit?offset+limit:null
    });
  },true);
}
