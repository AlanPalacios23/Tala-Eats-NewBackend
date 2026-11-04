/** M6 catalog controls: no checkout, billing, order reservations or uploads. */
import type {Pool} from 'pg';
import {RestaurantError,person,uuid,field,optionalText,integer,digest,type Actor} from './domain.js';
import {tx,access,audit,claim,complete} from './db.js';
type ProductRow={id:string,store_id:string,name:string,description:string,
 category:string,is_active:boolean,version:number,archived_at:Date|null};
type VariantRow={id:string,product_id:string,store_id:string,label:string,
 weight_grams:number|null,price_cents:string,stock_quantity:number,
 track_stock:boolean,is_active:boolean,version:number};
const fp=(v:unknown)=>digest(v);

export async function createProduct(pool:Pool,actor:Actor,input:{
 storeId:string,operationId:string,name:string,description?:string,
 category:string
}){
  const user=person(actor),storeId=uuid(input.storeId),op=uuid(input.operationId);
  const name=field(input.name,2,120),description=optionalText(input.description,1000);
  const category=field(input.category,2,60);
  const fingerprint=fp({storeId,name,description,category});
  return tx(pool,async c=>{
    await access(c,storeId,user,['owner','manager','editor'],true);
    const previous=await claim(c,user,op,'product.create',fingerprint);
    if(previous)return {id:previous,replayed:true};
    const r=await c.query<ProductRow>(
      'INSERT INTO tala_restaurants_v2.products(store_id,name,description,category) '+
      'VALUES($1::uuid,$2,$3,$4) RETURNING *',
      [storeId,name,description,category]);
    const id=r.rows[0]!.id;
    await audit(c,storeId,user,'product.create',id);
    await complete(c,user,op,id);
    return {id,replayed:false};
  });
}
export async function updateProduct(pool:Pool,actor:Actor,input:{
 storeId:string,productId:string,expectedVersion:number,
 name?:string,description?:string,category?:string,isActive?:boolean
}){
  const user=person(actor),store=uuid(input.storeId),id=uuid(input.productId);
  const ver=integer(input.expectedVersion,1,2147483646,'M6_VERSION_INVALID');
  if([input.name,input.description,input.category,input.isActive]
    .every(x=>x===undefined))throw new RestaurantError('M6_REQUEST_INVALID');
  const name=input.name===undefined?null:field(input.name,2,120);
  const description=input.description===undefined?null:optionalText(input.description,1000);
  const category=input.category===undefined?null:field(input.category,2,60);
  const active=input.isActive===undefined?null:input.isActive;
  if(active!==null&&typeof active!=='boolean')
    throw new RestaurantError('M6_ACTIVE_INVALID');
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager','editor'],true);
    const r=await c.query<ProductRow>(
      'UPDATE tala_restaurants_v2.products SET '+
      'name=COALESCE($4,name),description=COALESCE($5,description),'+
      'category=COALESCE($6,category),is_active=COALESCE($7,is_active),'+
      'version=version+1,updated_at=clock_timestamp() '+
      'WHERE id=$1::uuid AND store_id=$2::uuid AND version=$3 '+
      'AND archived_at IS NULL RETURNING *',
      [id,store,ver,name,description,category,active]);
    if(!r.rows[0])throw new RestaurantError('M6_VERSION_CONFLICT');
    await audit(c,store,user,'product.update',id);
    return {id,version:r.rows[0].version};
  });
}
export async function archiveProduct(pool:Pool,actor:Actor,input:{
 storeId:string,productId:string,expectedVersion:number
}){
  const user=person(actor),store=uuid(input.storeId),id=uuid(input.productId);
  const ver=integer(input.expectedVersion,1,2147483646,'M6_VERSION_INVALID');
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager'],true);
    const r=await c.query<ProductRow>(
      'UPDATE tala_restaurants_v2.products SET archived_at=clock_timestamp(),'+
      'is_active=false,version=version+1,updated_at=clock_timestamp() '+
      'WHERE id=$1::uuid AND store_id=$2::uuid AND version=$3 '+
      'AND archived_at IS NULL RETURNING *',[id,store,ver]);
    if(!r.rows[0])throw new RestaurantError('M6_VERSION_CONFLICT');
    await audit(c,store,user,'product.archive',id);
    return {id,archived:true};
  });
}
export async function createVariant(pool:Pool,actor:Actor,input:{
 storeId:string,productId:string,operationId:string,label:string,
 priceCents:number,weightGrams?:number,stockQuantity:number,trackStock:boolean
}){
  const user=person(actor),store=uuid(input.storeId),product=uuid(input.productId);
  const operationId=uuid(input.operationId),label=field(input.label,1,80);
  const price=integer(input.priceCents,1,100000000,'M6_PRICE_INVALID');
  const stock=integer(input.stockQuantity,0,1000000,'M6_STOCK_INVALID');
  const grams=input.weightGrams===undefined?null:integer(
    input.weightGrams,1,1000000,'M6_WEIGHT_INVALID');
  if(typeof input.trackStock!=='boolean')throw new RestaurantError('M6_STOCK_INVALID');
  if(!input.trackStock&&stock!==0)
    throw new RestaurantError('M6_STOCK_INVALID');
  const fingerprint=fp({store,product,label,price,stock,grams,
    trackStock:input.trackStock});
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager','editor'],true);
    const previous=await claim(c,user,operationId,'variant.create',fingerprint);
    if(previous)return {id:previous,replayed:true};
    const found=await c.query(
      'SELECT id FROM tala_restaurants_v2.products WHERE id=$1::uuid '+
      'AND store_id=$2::uuid AND archived_at IS NULL',[product,store]);
    if(!found.rowCount)throw new RestaurantError('M6_PRODUCT_NOT_FOUND');
    const r=await c.query<VariantRow>(
      'INSERT INTO tala_restaurants_v2.variants(store_id,product_id,label,'+
      'price_cents,weight_grams,stock_quantity,track_stock) '+
      'VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7) RETURNING *',
      [store,product,label,price,grams,stock,input.trackStock]);
    const id=r.rows[0]!.id;
    await audit(c,store,user,'variant.create',id);
    await complete(c,user,operationId,id);
    return {id,replayed:false};
  });
}
export async function setVariantPrice(pool:Pool,actor:Actor,input:{
 storeId:string,variantId:string,expectedVersion:number,priceCents:number
}){
  const user=person(actor),store=uuid(input.storeId),id=uuid(input.variantId);
  const ver=integer(input.expectedVersion,1,2147483646,'M6_VERSION_INVALID');
  const price=integer(input.priceCents,1,100000000,'M6_PRICE_INVALID');
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager','editor'],true);
    const r=await c.query<VariantRow>(
      'UPDATE tala_restaurants_v2.variants v SET price_cents=$4,'+
      'version=v.version+1,updated_at=clock_timestamp() '+
      'FROM tala_restaurants_v2.products p WHERE v.id=$1::uuid '+
      'AND v.store_id=$2::uuid AND v.version=$3 AND p.id=v.product_id '+
      'AND p.store_id=v.store_id AND p.archived_at IS NULL RETURNING v.*',
      [id,store,ver,price]);
    if(!r.rows[0])throw new RestaurantError('M6_VERSION_CONFLICT');
    await audit(c,store,user,'variant.price',id);
    return {id,priceCents:price,version:r.rows[0].version};
  });
}
export async function adjustStock(pool:Pool,actor:Actor,input:{
 storeId:string,variantId:string,operationId:string,delta:number,
 reason:'restock'|'correction'|'waste'
}){
  const user=person(actor),store=uuid(input.storeId),id=uuid(input.variantId);
  const op=uuid(input.operationId);
  const delta=integer(input.delta,-1000000,1000000,'M6_STOCK_INVALID');
  if(delta===0)throw new RestaurantError('M6_STOCK_INVALID');
  if(!['restock','correction','waste'].includes(input.reason)||
     (input.reason==='waste'&&delta>=0)||
     (input.reason==='restock'&&delta<=0))
    throw new RestaurantError('M6_STOCK_REASON_INVALID');
  const fingerprint=fp({store,id,delta,reason:input.reason});
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager','editor'],true);
    const previous=await claim(c,user,op,'stock.adjust',fingerprint);
    if(previous){
      const adjustment=await c.query<{quantity_before:number,
        quantity_after:number}>(
        'SELECT quantity_before,quantity_after '+
        'FROM tala_restaurants_v2.stock_adjustments WHERE id=$1::uuid '+
        'AND store_id=$2::uuid',[previous,store]);
      if(!adjustment.rows[0])throw new RestaurantError('M6_RECEIPT_INVALID');
      return {id:previous,replayed:true,before:adjustment.rows[0].quantity_before,
        after:adjustment.rows[0].quantity_after};
    }
    const changed=await c.query<VariantRow>(
      'UPDATE tala_restaurants_v2.variants v SET '+
      'stock_quantity=v.stock_quantity+$3,version=v.version+1,'+
      'updated_at=clock_timestamp() '+
      'FROM tala_restaurants_v2.products p WHERE v.id=$1::uuid '+
      'AND v.store_id=$2::uuid AND v.track_stock AND '+
      'p.id=v.product_id AND p.store_id=v.store_id AND '+
      'p.archived_at IS NULL AND v.stock_quantity+$3 BETWEEN 0 AND 1000000 '+
      'RETURNING v.*',[id,store,delta]);
    const next=changed.rows[0];
    if(!next)throw new RestaurantError('M6_STOCK_CONFLICT');
    const before=next.stock_quantity-delta;
    const history=await c.query<{id:string}>(
      'INSERT INTO tala_restaurants_v2.stock_adjustments '+
      '(store_id,variant_id,actor_id,operation_id,delta,quantity_before,'+
      'quantity_after,reason) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'+
      '$5,$6,$7,$8) RETURNING id',
      [store,id,user,op,delta,before,next.stock_quantity,input.reason]);
    const historyId=history.rows[0]!.id;
    await audit(c,store,user,'stock.adjust',id);
    await complete(c,user,op,historyId);
    return {id:historyId,replayed:false,before,after:next.stock_quantity};
  });
}
export async function readCatalog(pool:Pool,actor:Actor,storeId:string){
  const user=person(actor),store=uuid(storeId);
  return tx(pool,async c=>{
    await access(c,store,user);
    const products=await c.query<ProductRow>(
      'SELECT id,store_id,name,description,category,is_active,version,archived_at '+
      'FROM tala_restaurants_v2.products WHERE store_id=$1::uuid '+
      'ORDER BY created_at DESC LIMIT 500',[store]);
    const variants=await c.query<VariantRow>(
      'SELECT id,product_id,store_id,label,weight_grams,price_cents,'+
      'stock_quantity,track_stock,is_active,version '+
      'FROM tala_restaurants_v2.variants WHERE store_id=$1::uuid '+
      'ORDER BY created_at DESC LIMIT 2000',[store]);
    return {products:products.rows,variants:variants.rows};
  },true);
}
/** Trusted read-side contract for M1. Does not reserve stock, collect money or assign orders. */
export async function readOfferSnapshot(pool:Pool,input:{
 storeId:string,branchId:string,variantId:string,at?:Date
}){
  const store=uuid(input.storeId),branch=uuid(input.branchId),variant=uuid(input.variantId);
  const at=input.at??new Date();
  if(!(at instanceof Date)||!Number.isFinite(at.getTime()))
    throw new RestaurantError('M6_TIME_INVALID');
  return tx(pool,async c=>{
    const r=await c.query<{
      store_id:string,branch_id:string,variant_id:string,product_id:string,
      product_name:string,variant_label:string,weight_grams:number|null,
      price_cents:string,currency:string,stock_quantity:number,
      track_stock:boolean,variant_version:number,available:boolean
    }>(
      'SELECT s.id AS store_id,b.id AS branch_id,v.id AS variant_id,'+
      'p.id AS product_id,p.name AS product_name,v.label AS variant_label,'+
      'v.weight_grams,v.price_cents,\'MXN\'::text AS currency,'+
      'v.stock_quantity,v.track_stock,v.version AS variant_version,'+
      '((NOT v.track_stock OR v.stock_quantity>0) AND '+
      'NOT coalesce(h.closed,true) AND '+
      '(extract(hour from ($4::timestamptz AT TIME ZONE '+
      "'America/Mexico_City'))::int*60+"+
      'extract(minute from ($4::timestamptz AT TIME ZONE '+
      "'America/Mexico_City'))::int) >= h.open_minute AND "+
      '(extract(hour from ($4::timestamptz AT TIME ZONE '+
      "'America/Mexico_City'))::int*60+"+
      'extract(minute from ($4::timestamptz AT TIME ZONE '+
      "'America/Mexico_City'))::int) < h.close_minute AND "+
      'NOT EXISTS(SELECT 1 FROM tala_restaurants_v2.branch_closures e '+
      'WHERE e.branch_id=b.id AND e.store_id=s.id '+
      'AND e.cancelled_at IS NULL AND e.starts_at<=$4::timestamptz '+
      'AND e.ends_at>$4::timestamptz)) AS available '+
      'FROM tala_restaurants_v2.stores s '+
      'JOIN tala_restaurants_v2.branches b ON b.store_id=s.id '+
      'JOIN tala_restaurants_v2.products p ON p.store_id=s.id '+
      'JOIN tala_restaurants_v2.variants v ON v.product_id=p.id '+
      'AND v.store_id=p.store_id '+
      'LEFT JOIN tala_restaurants_v2.branch_variant_controls ctrl '+
      'ON ctrl.store_id=v.store_id AND ctrl.branch_id=b.id '+
      'AND ctrl.variant_id=v.id '+
      'LEFT JOIN tala_restaurants_v2.hours h ON h.branch_id=b.id '+
      'AND h.weekday=extract(dow FROM ($4::timestamptz AT TIME ZONE '+
      "'America/Mexico_City'))::int "+
      'WHERE s.id=$1::uuid AND b.id=$2::uuid AND v.id=$3::uuid '+
      'AND coalesce(ctrl.enabled,true) '+
      "AND s.status='ready' AND b.is_active AND p.is_active "+
      'AND p.archived_at IS NULL AND v.is_active',
      [store,branch,variant,at]);
    if(!r.rows[0])throw new RestaurantError('M6_OFFER_UNAVAILABLE');
    return Object.freeze(r.rows[0]);
  },true);
}
