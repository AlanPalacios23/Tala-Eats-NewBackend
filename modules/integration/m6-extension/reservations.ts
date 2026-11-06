/** M11 LAB6 temporary M6-domain extension. Physically operates ONLY against
 * M6 LAB PostgreSQL. Its SQL migration belongs to M11, not the pinned M6
 * subtree. Move this contract inside M6 before any commercial deployment.
 */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {IntegrationError,validUuid} from '../src/events.js';

export type ReserveLine={
 variantId:string,quantity:number,expectedVersion:number,
 expectedPriceMinor:string,expectedName:string
};
export type ReserveInput={
 holdId:string,storeId:string,branchId:string,lines:ReserveLine[],
 ttlSeconds?:number
};
type HoldLine={
 variantId:string,quantity:number,variantVersion:number,
 priceMinor:string,name:string,stockBefore:number,stockAfter:number
};
type HoldState='reserved'|'confirmed'|'released';
const noLive=()=>{
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
};
const safeQty=(n:number)=>
 Number.isSafeInteger(n)&&n>=1&&n<=100;
function normalize(input:ReserveInput){
 noLive();
 const holdId=validUuid(input.holdId),storeId=validUuid(input.storeId),
  branchId=validUuid(input.branchId);
 if(!Array.isArray(input.lines)||input.lines.length===0||
   input.lines.length>50)
  throw new IntegrationError('M11_HOLD_LINES_INVALID');
 const lines=input.lines.map(x=>{
  const variantId=validUuid(x.variantId);
  if(!safeQty(x.quantity)||!Number.isSafeInteger(x.expectedVersion)||
    x.expectedVersion<1||x.expectedVersion>2147483646||
    !/^[1-9][0-9]{0,8}$/.test(x.expectedPriceMinor)||
    typeof x.expectedName!=='string'||x.expectedName.length<3||
    x.expectedName.length>240)
   throw new IntegrationError('M11_HOLD_LINES_INVALID');
  return {variantId,quantity:x.quantity,expectedVersion:x.expectedVersion,
   expectedPriceMinor:x.expectedPriceMinor,expectedName:x.expectedName};
 }).sort((a,b)=>a.variantId.localeCompare(b.variantId));
 if(new Set(lines.map(x=>x.variantId)).size!==lines.length)
  throw new IntegrationError('M11_HOLD_LINES_DUPLICATE');
 const ttlSeconds=input.ttlSeconds??300;
 if(!Number.isSafeInteger(ttlSeconds)||ttlSeconds<60||ttlSeconds>900)
  throw new IntegrationError('M11_HOLD_TTL_INVALID');
 const fingerprint=createHash('sha256').update(JSON.stringify({
  storeId,branchId,lines
 })).digest('hex');
 return {holdId,storeId,branchId,lines,ttlSeconds,fingerprint};
}
async function transaction<T>(pool:Pool,work:(c:PoolClient)=>Promise<T>){
 noLive();
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query("SET LOCAL statement_timeout='15000ms'");
  await c.query("SET LOCAL lock_timeout='4000ms'");
  const n=await c.query<{name:string}>('SELECT current_database() AS name');
  if(!['tala_restaurants_v2_test','tala_restaurants_v2_lab']
   .includes(n.rows[0]?.name??''))
   throw new IntegrationError('M11_M6_LAB_ONLY');
  const result=await work(c);
  await c.query('COMMIT');
  return result;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;
 }finally{c.release();}
}
async function currentHold(c:PoolClient,id:string){
 const r=await c.query<{state:HoldState,fingerprint:string,
  m1_order_id:string|null,expires_at:Date}>(
  'SELECT state,fingerprint,m1_order_id,expires_at '+
  'FROM tala_restaurants_v2.order_stock_holds WHERE hold_id=$1::uuid '+
  'FOR UPDATE',[id]);
 return r.rows[0]??null;
}
async function readHoldLines(c:PoolClient,id:string):Promise<HoldLine[]>{
 const r=await c.query<{variant_id:string,quantity:number,
  variant_version:number,price_minor:string,name_snapshot:string,
  stock_before:number,stock_after:number}>(
  'SELECT variant_id,quantity,variant_version,price_minor::text,'+
  'name_snapshot,stock_before,stock_after FROM '+
  'tala_restaurants_v2.order_stock_hold_lines '+
  'WHERE hold_id=$1::uuid ORDER BY line_no',[id]);
 return r.rows.map(x=>({
  variantId:x.variant_id,quantity:x.quantity,
  variantVersion:x.variant_version,priceMinor:x.price_minor,
  name:x.name_snapshot,stockBefore:x.stock_before,stockAfter:x.stock_after
 }));
}
export async function reserveM6BranchStock(pool:Pool,input:ReserveInput){
 const data=normalize(input);
 return transaction(pool,async c=>{
  // Exact idempotency under hold lock. No stock changes on retry.
  const old=await currentHold(c,data.holdId);
  if(old){
   if(old.fingerprint!==data.fingerprint)
    throw new IntegrationError('M11_HOLD_IDEMPOTENCY_CONFLICT');
   return Object.freeze({holdId:data.holdId,state:old.state,
    replayed:true as const,expiresAt:old.expires_at.toISOString(),
    lines:await readHoldLines(c,data.holdId)});
  }
  const expiresAt=new Date(Date.now()+data.ttlSeconds*1000);
  await c.query(
   'INSERT INTO tala_restaurants_v2.order_stock_holds '+
   '(hold_id,store_id,branch_id,fingerprint,expires_at) '+
   'VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz)',
   [data.holdId,data.storeId,data.branchId,data.fingerprint,expiresAt]);
  const lines:HoldLine[]=[];
  for(const [i,line] of data.lines.entries()){
   // A real M6 branch-physical stock row is mandatory. We do NOT use
   // store-wide legacy inventory. The variant row/stock row locks
   // serialize with existing merchant restock/adjust functions.
   const r=await c.query<{
    store_status:string,branch_active:boolean,pickup_enabled:boolean,
    schedule_open:boolean,closed:boolean,control_enabled:boolean,
    product_active:boolean,archived:boolean,variant_active:boolean,
    track_stock:boolean,branch_stock_enabled:boolean,
    variant_version:number,price_minor:string,product_name:string,
    variant_label:string,quantity:number,weight_grams:number|null
   }>(
    'SELECT s.status AS store_status,b.is_active AS branch_active,'+
    'b.pickup_enabled,'+
    'tala_restaurants_v2.is_branch_scheduled_open(b.id,clock_timestamp()) '+
    'AS schedule_open,'+
    'EXISTS(SELECT 1 FROM tala_restaurants_v2.branch_closures cl '+
    'WHERE cl.store_id=s.id AND cl.branch_id=b.id AND '+
    'cl.cancelled_at IS NULL AND cl.starts_at<=clock_timestamp() '+
    'AND cl.ends_at>clock_timestamp()) AS closed,'+
    'coalesce(ctrl.enabled,true) AS control_enabled,'+
    'p.is_active AS product_active,(p.archived_at IS NOT NULL) AS archived,'+
    'v.is_active AS variant_active,v.track_stock,v.branch_stock_enabled,'+
    'v.version AS variant_version,v.price_cents::text AS price_minor,'+
    'p.name AS product_name,v.label AS variant_label,'+
    'bs.quantity,v.weight_grams '+
    'FROM tala_restaurants_v2.stores s '+
    'JOIN tala_restaurants_v2.branches b ON b.store_id=s.id '+
    'JOIN tala_restaurants_v2.products p ON p.store_id=s.id '+
    'JOIN tala_restaurants_v2.variants v ON v.product_id=p.id '+
    'AND v.store_id=p.store_id '+
    'JOIN tala_restaurants_v2.branch_stock bs ON '+
    'bs.store_id=s.id AND bs.branch_id=b.id AND bs.variant_id=v.id '+
    'LEFT JOIN tala_restaurants_v2.branch_variant_controls ctrl ON '+
    'ctrl.store_id=s.id AND ctrl.branch_id=b.id AND ctrl.variant_id=v.id '+
    'WHERE s.id=$1::uuid AND b.id=$2::uuid AND v.id=$3::uuid '+
    'FOR UPDATE OF bs,v',
    [data.storeId,data.branchId,line.variantId]);
   const row=r.rows[0];
   if(!row||row.store_status!=='ready'||!row.branch_active||
     !row.pickup_enabled||!row.schedule_open||row.closed||
     !row.control_enabled||!row.product_active||row.archived||
     !row.variant_active||!row.track_stock||!row.branch_stock_enabled)
    throw new IntegrationError('M11_M6_BRANCH_OFFER_UNAVAILABLE');
   if(row.variant_version!==line.expectedVersion)
    throw new IntegrationError('M11_HOLD_VERSION_DRIFT');
   const fullName=row.product_name+' — '+row.variant_label;
   if(row.price_minor!==line.expectedPriceMinor||
      fullName!==line.expectedName)
    throw new IntegrationError('M11_HOLD_PRICE_DRIFT');
   if(row.quantity<line.quantity)
    throw new IntegrationError('M11_HOLD_OUT_OF_STOCK');
   const after=row.quantity-line.quantity;
   const changed=await c.query(
    'UPDATE tala_restaurants_v2.branch_stock SET quantity=quantity-$4,'+
    'version=version+1,updated_at=clock_timestamp() '+
    'WHERE store_id=$1::uuid AND branch_id=$2::uuid '+
    'AND variant_id=$3::uuid AND quantity>=$4',
    [data.storeId,data.branchId,line.variantId,line.quantity]);
   if(changed.rowCount!==1)
    throw new IntegrationError('M11_HOLD_OUT_OF_STOCK');
   await c.query(
    'INSERT INTO tala_restaurants_v2.order_stock_hold_lines '+
    '(hold_id,line_no,variant_id,store_id,branch_id,quantity,'+
    'variant_version,price_minor,name_snapshot,weight_grams,'+
    'stock_before,stock_after) VALUES($1::uuid,$2,$3::uuid,$4::uuid,'+
    '$5::uuid,$6,$7,$8,$9,$10,$11,$12)',
    [data.holdId,i+1,line.variantId,data.storeId,data.branchId,
     line.quantity,row.variant_version,row.price_minor,fullName,
     row.weight_grams,row.quantity,after]);
   lines.push({variantId:line.variantId,quantity:line.quantity,
    variantVersion:row.variant_version,priceMinor:row.price_minor,
    name:fullName,stockBefore:row.quantity,stockAfter:after});
  }
  await c.query(
   "INSERT INTO tala_restaurants_v2.order_stock_hold_events "+
   "(hold_id,event_type) VALUES($1::uuid,'inventory.reserved')",
   [data.holdId]);
  return Object.freeze({holdId:data.holdId,state:'reserved' as const,
   replayed:false as const,expiresAt:expiresAt.toISOString(),lines});
 });
}
export async function confirmM6BranchStock(pool:Pool,holdId:string,
 m1OrderId:string){
 noLive();
 const id=validUuid(holdId),orderId=validUuid(m1OrderId);
 return transaction(pool,async c=>{
  const hold=await currentHold(c,id);
  if(!hold)throw new IntegrationError('M11_HOLD_NOT_FOUND');
  if(hold.state==='released')throw new IntegrationError('M11_HOLD_RELEASED');
  if(hold.state==='confirmed'){
   if(hold.m1_order_id!==orderId)
    throw new IntegrationError('M11_HOLD_ORDER_CONFLICT');
   return Object.freeze({holdId:id,orderId,confirmed:true as const,
    replayed:true as const});
  }
  await c.query(
   "UPDATE tala_restaurants_v2.order_stock_holds SET state='confirmed',"+
   'm1_order_id=$2::uuid,updated_at=clock_timestamp() WHERE hold_id=$1::uuid',
   [id,orderId]);
  await c.query(
   'INSERT INTO tala_restaurants_v2.order_stock_hold_events '+
   "(hold_id,event_type,order_id) VALUES($1::uuid,'inventory.confirmed',$2::uuid)",
   [id,orderId]);
  return Object.freeze({holdId:id,orderId,confirmed:true as const,
   replayed:false as const});
 });
}
/** Only call after verified M1 has NO committed order for this intent.
 * Does NOT run automatically on TTL, because external checkout may be
 * in-flight. Reconciliation must acquire the same M11 intent lock.
 */
export async function releaseM6BranchStock(pool:Pool,holdId:string){
 noLive();
 const id=validUuid(holdId);
 return transaction(pool,async c=>{
  const hold=await currentHold(c,id);
  if(!hold)throw new IntegrationError('M11_HOLD_NOT_FOUND');
  if(hold.state==='confirmed')
   throw new IntegrationError('M11_HOLD_ALREADY_CONFIRMED');
  if(hold.state==='released')
   return Object.freeze({holdId:id,released:true as const,replayed:true as const});
  const r=await c.query<{branch_id:string,variant_id:string,quantity:number}>(
   'SELECT branch_id,variant_id,quantity '+
   'FROM tala_restaurants_v2.order_stock_hold_lines '+
   'WHERE hold_id=$1::uuid ORDER BY variant_id',[id]);
  for(const line of r.rows){
   const update=await c.query(
    'UPDATE tala_restaurants_v2.branch_stock SET quantity=quantity+$3,'+
    'version=version+1,updated_at=clock_timestamp() '+
    'WHERE branch_id=$1::uuid AND variant_id=$2::uuid '+
    'AND quantity+$3<=1000000',
    [line.branch_id,line.variant_id,line.quantity]);
   if(update.rowCount!==1)
    throw new IntegrationError('M11_HOLD_RELEASE_STOCK_CONFLICT');
  }
  await c.query(
   "UPDATE tala_restaurants_v2.order_stock_holds SET state='released',"+
   'updated_at=clock_timestamp() WHERE hold_id=$1::uuid',[id]);
  await c.query(
   'INSERT INTO tala_restaurants_v2.order_stock_hold_events '+
   "(hold_id,event_type) VALUES($1::uuid,'inventory.released')",[id]);
  return Object.freeze({holdId:id,released:true as const,replayed:false as const});
 });
}
export async function inspectM6StockHold(pool:Pool,holdId:string){
 noLive();
 const id=validUuid(holdId);
 return transaction(pool,async c=>{
  const hold=await currentHold(c,id);
  if(!hold)return null;
  return Object.freeze({holdId:id,state:hold.state,orderId:hold.m1_order_id,
   expiresAt:hold.expires_at.toISOString(),
   lines:await readHoldLines(c,id)});
 });
}
