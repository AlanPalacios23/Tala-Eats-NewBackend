/** M6 internal store governance. Identity must be verified by the host. */
import type {Pool} from 'pg';
import {RestaurantError,person,uuid,slug,field,member,integer,
  optionalText,digest,KINDS,CITIES,ROLES,type Actor,type Kind,type City,type Role} from './domain.js';
import {tx,access,audit,claim,complete} from './db.js';
type StoreRow={id:string,owner_id:string,slug:string,display_name:string,
 kind:Kind,status:'draft'|'ready'|'paused',description:string,version:number};
export async function createStore(pool:Pool,actor:Actor,input:{
  operationId:string,slug:string,name:string,kind:Kind,description?:string
}){
  const owner=person(actor),operationId=uuid(input.operationId);
  const name=field(input.name,2,100),storeSlug=slug(input.slug);
  const kind=member(input.kind,KINDS,'M6_KIND_INVALID');
  const description=optionalText(input.description,1000);
  const fingerprint=digest({name,slug:storeSlug,kind,description});
  return tx(pool,async c=>{
    const existing=await claim(c,owner,operationId,'store.create',fingerprint);
    if(existing)return {id:existing,replayed:true};
    const row=await c.query<StoreRow>(
      'INSERT INTO tala_restaurants_v2.stores(owner_id,slug,display_name,kind,description) '+
      'VALUES($1::uuid,$2,$3,$4,$5) RETURNING *',
      [owner,storeSlug,name,kind,description]);
    const store=row.rows[0]!;
    await c.query(
      "INSERT INTO tala_restaurants_v2.store_staff(store_id,actor_id,role) "+
      "VALUES($1::uuid,$2::uuid,'owner')",[store.id,owner]);
    await audit(c,store.id,owner,'store.create',store.id);
    await complete(c,owner,operationId,store.id);
    return {id:store.id,replayed:false};
  });
}
export async function readStore(pool:Pool,actor:Actor,storeId:string){
  const id=uuid(storeId),user=person(actor);
  return tx(pool,async c=>{
    await access(c,id,user);
    const r=await c.query<StoreRow>(
      'SELECT id,owner_id,slug,display_name,kind,status,description,version '+
      'FROM tala_restaurants_v2.stores WHERE id=$1::uuid',[id]);
    const staff=await c.query<{actor_id:string,role:Role}>(
      'SELECT actor_id,role FROM tala_restaurants_v2.store_staff '+
      'WHERE store_id=$1::uuid ORDER BY role,actor_id',[id]);
    return Object.freeze({store:r.rows[0]!,staff:staff.rows});
  },true);
}
export async function listMyStores(pool:Pool,actor:Actor){
  const user=person(actor);
  return tx(pool,async c=>{
    const r=await c.query<StoreRow&{role:Role}>(
      'SELECT s.id,s.owner_id,s.slug,s.display_name,s.kind,s.status,'+
      's.description,s.version,m.role FROM tala_restaurants_v2.stores s '+
      'JOIN tala_restaurants_v2.store_staff m ON m.store_id=s.id '+
      'WHERE m.actor_id=$1::uuid ORDER BY s.created_at DESC LIMIT 100',
      [user]);
    return r.rows;
  },true);
}
export async function updateStore(pool:Pool,actor:Actor,input:{
  storeId:string,expectedVersion:number,name?:string,description?:string
}){
  const user=person(actor),storeId=uuid(input.storeId);
  const expectedVersion=integer(input.expectedVersion,1,2147483646,'M6_VERSION_INVALID');
  if(input.name===undefined&&input.description===undefined)
    throw new RestaurantError('M6_REQUEST_INVALID');
  const name=input.name===undefined?null:field(input.name,2,100);
  const description=input.description===undefined?null:optionalText(input.description,1000);
  return tx(pool,async c=>{
    await access(c,storeId,user,['owner','manager'],true);
    const r=await c.query<StoreRow>(
      'UPDATE tala_restaurants_v2.stores SET '+
      'display_name=COALESCE($3,display_name),description=COALESCE($4,description),'+
      'version=version+1,updated_at=clock_timestamp() '+
      'WHERE id=$1::uuid AND version=$2 RETURNING *',
      [storeId,expectedVersion,name,description]);
    if(!r.rows[0])throw new RestaurantError('M6_VERSION_CONFLICT');
    await audit(c,storeId,user,'store.update',storeId);
    return {id:storeId,version:r.rows[0].version};
  });
}
export async function changeStoreStatus(pool:Pool,actor:Actor,input:{
 storeId:string,expectedVersion:number,status:'draft'|'ready'|'paused'
}){
  const user=person(actor),id=uuid(input.storeId);
  const ver=integer(input.expectedVersion,1,2147483646,'M6_VERSION_INVALID');
  const status=member(input.status,['draft','ready','paused'] as const,
    'M6_STATUS_INVALID');
  return tx(pool,async c=>{
    const current=await access(c,id,user,['owner'],true);
    if(current.version!==ver)throw new RestaurantError('M6_VERSION_CONFLICT');
    if(status==='ready'){
      // LAB readiness is not a production approval or publication.
      const gate=await c.query<{ready:boolean}>(
        'SELECT EXISTS(SELECT 1 FROM tala_restaurants_v2.branches b '+
        'JOIN tala_restaurants_v2.hours h ON h.branch_id=b.id AND NOT h.closed '+
        'JOIN tala_restaurants_v2.products p ON p.store_id=b.store_id '+
        'JOIN tala_restaurants_v2.variants v ON v.product_id=p.id '+
        'AND v.store_id=p.store_id '+
        'LEFT JOIN tala_restaurants_v2.branch_variant_controls ctrl '+
        'ON ctrl.store_id=b.store_id AND ctrl.branch_id=b.id '+
        'AND ctrl.variant_id=v.id '+
        'LEFT JOIN tala_restaurants_v2.branch_stock bs '+
        'ON bs.store_id=b.store_id AND bs.branch_id=b.id '+
        'AND bs.variant_id=v.id '+
        'WHERE b.store_id=$1::uuid AND b.is_active '+
        'AND p.is_active AND p.archived_at IS NULL AND v.is_active '+
        'AND coalesce(ctrl.enabled,true) AND '+
        '(NOT v.track_stock OR (CASE WHEN v.branch_stock_enabled '+
        'THEN coalesce(bs.quantity,0) ELSE v.stock_quantity END)>0)) AS ready',
        [id]);
      if(!gate.rows[0]?.ready)
        throw new RestaurantError('M6_ONBOARDING_INCOMPLETE');
    }
    const r=await c.query<StoreRow>(
      'UPDATE tala_restaurants_v2.stores SET status=$3,version=version+1,'+
      'updated_at=clock_timestamp() WHERE id=$1::uuid AND version=$2 RETURNING *',
      [id,ver,status]);
    if(!r.rows[0])throw new RestaurantError('M6_VERSION_CONFLICT');
    await audit(c,id,user,'store.status',id);
    return {storeId:id,status,version:r.rows[0].version};
  });
}
export async function setStaffRole(pool:Pool,actor:Actor,input:{
 storeId:string,memberId:string,role:'manager'|'editor'|null
}){
  const user=person(actor),id=uuid(input.storeId),target=uuid(input.memberId);
  if(target===user)throw new RestaurantError('M6_OWNER_IMMUTABLE');
  if(input.role!==null)member(input.role,['manager','editor'] as const,'M6_ROLE_INVALID');
  return tx(pool,async c=>{
    await access(c,id,user,['owner'],true);
    const store=await c.query<{owner_id:string}>(
      'SELECT owner_id FROM tala_restaurants_v2.stores WHERE id=$1::uuid',[id]);
    if(target===store.rows[0]?.owner_id)
      throw new RestaurantError('M6_OWNER_IMMUTABLE');
    if(input.role===null){
      await c.query(
        "DELETE FROM tala_restaurants_v2.store_staff "+
        "WHERE store_id=$1::uuid AND actor_id=$2::uuid AND role<>'owner'",
        [id,target]);
    }else{
      await c.query(
        'INSERT INTO tala_restaurants_v2.store_staff(store_id,actor_id,role) '+
        'VALUES($1::uuid,$2::uuid,$3) ON CONFLICT(store_id,actor_id) '+
        "DO UPDATE SET role=EXCLUDED.role WHERE store_staff.role<>'owner'",
        [id,target,input.role]);
    }
    await audit(c,id,user,'store.staff',target);
    return {storeId:id,memberId:target,role:input.role};
  });
}
export async function createBranch(pool:Pool,actor:Actor,input:{
 storeId:string,operationId:string,name:string,address:string,city:City,
 pickupEnabled:boolean,deliveryEnabled:boolean,
 latitude?:number,longitude?:number
}){
  const user=person(actor),storeId=uuid(input.storeId),operationId=uuid(input.operationId);
  const name=field(input.name,2,100),address=field(input.address,5,255);
  const city=member(input.city,CITIES,'M6_CITY_INVALID');
  if(typeof input.pickupEnabled!=='boolean'||typeof input.deliveryEnabled!=='boolean'||
     (!input.pickupEnabled&&!input.deliveryEnabled))
    throw new RestaurantError('M6_FULFILLMENT_INVALID');
  let latitude:null|number=null,longitude:null|number=null;
  if(input.latitude!==undefined||input.longitude!==undefined){
    if(typeof input.latitude!=='number'||typeof input.longitude!=='number'||
       !Number.isFinite(input.latitude)||!Number.isFinite(input.longitude)||
       input.latitude< -90||input.latitude>90||
       input.longitude< -180||input.longitude>180)
      throw new RestaurantError('M6_COORDINATES_INVALID');
    latitude=input.latitude;longitude=input.longitude;
  }
  const fp=digest({storeId,name,address,city,pickupEnabled:input.pickupEnabled,
    deliveryEnabled:input.deliveryEnabled,latitude,longitude});
  return tx(pool,async c=>{
    await access(c,storeId,user,['owner','manager'],true);
    const previous=await claim(c,user,operationId,'branch.create',fp);
    if(previous)return {id:previous,replayed:true};
    const r=await c.query<{id:string}>(
      'INSERT INTO tala_restaurants_v2.branches(store_id,branch_name,'+
      'address_text,city,pickup_enabled,delivery_enabled,latitude,longitude) '+
      'VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [storeId,name,address,city,input.pickupEnabled,input.deliveryEnabled,
        latitude,longitude]);
    const id=r.rows[0]!.id;
    await audit(c,storeId,user,'branch.create',id);
    await complete(c,user,operationId,id);
    return {id,replayed:false};
  });
}
export type DayHours={weekday:number,closed:boolean,openMinute?:number,
 closeMinute?:number};
export async function setBranchHours(pool:Pool,actor:Actor,input:{
 storeId:string,branchId:string,expectedVersion:number,days:DayHours[]
}){
  const user=person(actor),store=uuid(input.storeId),branch=uuid(input.branchId);
  const version=integer(input.expectedVersion,1,2147483646,'M6_VERSION_INVALID');
  if(!Array.isArray(input.days)||input.days.length<1||input.days.length>7)
    throw new RestaurantError('M6_HOURS_INVALID');
  const normalized=input.days.map(d=>{
    const weekday=integer(d.weekday,0,6,'M6_HOURS_INVALID');
    if(typeof d.closed!=='boolean')throw new RestaurantError('M6_HOURS_INVALID');
    if(d.closed){
      if(d.openMinute!==undefined||d.closeMinute!==undefined)
        throw new RestaurantError('M6_HOURS_INVALID');
      return {weekday,closed:true,open:null,close:null};
    }
    const open=integer(d.openMinute,0,1439,'M6_HOURS_INVALID');
    const close=integer(d.closeMinute,1,1440,'M6_HOURS_INVALID');
    if(close<=open)throw new RestaurantError('M6_HOURS_INVALID');
    return {weekday,closed:false,open,close};
  });
  if(new Set(normalized.map(x=>x.weekday)).size!==normalized.length)
    throw new RestaurantError('M6_HOURS_INVALID');
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager'],true);
    const r=await c.query<{version:number}>(
      'UPDATE tala_restaurants_v2.branches SET version=version+1,'+
      'updated_at=clock_timestamp() WHERE id=$1::uuid AND store_id=$2::uuid '+
      'AND version=$3 RETURNING version',[branch,store,version]);
    if(!r.rows[0])throw new RestaurantError('M6_VERSION_CONFLICT');
    for(const d of normalized){
      await c.query(
        'INSERT INTO tala_restaurants_v2.hours '+
        '(branch_id,weekday,closed,open_minute,close_minute) '+
        'VALUES($1::uuid,$2,$3,$4,$5) ON CONFLICT(branch_id,weekday) DO UPDATE '+
        'SET closed=EXCLUDED.closed,open_minute=EXCLUDED.open_minute,'+
        'close_minute=EXCLUDED.close_minute,updated_at=clock_timestamp()',
        [branch,d.weekday,d.closed,d.open,d.close]);
    }
    await audit(c,store,user,'branch.hours',branch);
    return {branchId:branch,version:r.rows[0].version,updatedDays:normalized.length};
  });
}
export async function listBranches(pool:Pool,actor:Actor,storeId:string){
  const user=person(actor),id=uuid(storeId);
  return tx(pool,async c=>{
    await access(c,id,user);
    const r=await c.query(
      'SELECT id,branch_name,address_text,city,pickup_enabled,'+
      'delivery_enabled,latitude,longitude,is_active,version '+
      'FROM tala_restaurants_v2.branches WHERE store_id=$1::uuid ORDER BY created_at',
      [id]);
    const h=await c.query(
      'SELECT h.branch_id,h.weekday,h.closed,h.open_minute,h.close_minute '+
      'FROM tala_restaurants_v2.hours h JOIN tala_restaurants_v2.branches b '+
      'ON b.id=h.branch_id WHERE b.store_id=$1::uuid ORDER BY h.weekday',[id]);
    return {branches:r.rows,hours:h.rows};
  },true);
}


/** Operational pause is not an order cancellation or dispatch decision. */
export async function setBranchActive(pool:Pool,actor:Actor,input:{
 storeId:string,branchId:string,expectedVersion:number,active:boolean
}){
  const user=person(actor),store=uuid(input.storeId),branch=uuid(input.branchId);
  const ver=integer(input.expectedVersion,1,2147483646,'M6_VERSION_INVALID');
  if(typeof input.active!=='boolean')throw new RestaurantError('M6_ACTIVE_INVALID');
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager'],true);
    const r=await c.query<{version:number}>(
      'UPDATE tala_restaurants_v2.branches SET is_active=$4,'+
      'version=version+1,updated_at=clock_timestamp() '+
      'WHERE id=$1::uuid AND store_id=$2::uuid AND version=$3 '+
      'RETURNING version',[branch,store,ver,input.active]);
    if(!r.rows[0])throw new RestaurantError('M6_VERSION_CONFLICT');
    await audit(c,store,user,'branch.status',branch);
    return {branchId:branch,active:input.active,version:r.rows[0].version};
  });
}
/** Internal read-only contract. Store is not offered for sale outside its
 * configured local schedule. No holiday overrides or live dispatch here.
 */
export async function getBranchAvailability(pool:Pool,input:{
 storeId:string,branchId:string,at?:Date
}){
  const store=uuid(input.storeId),branch=uuid(input.branchId);
  const when=input.at??new Date();
  if(!(when instanceof Date)||!Number.isFinite(when.getTime()))
    throw new RestaurantError('M6_TIME_INVALID');
  return tx(pool,async c=>{
    const r=await c.query<{
      status:'draft'|'ready'|'paused',is_active:boolean,pickup_enabled:boolean,
      delivery_enabled:boolean,closed:boolean,exception_closed:boolean,
      open_minute:number|null,close_minute:number|null,local_minute:number
    }>(
      'SELECT s.status,b.is_active,b.pickup_enabled,b.delivery_enabled,'+
      'coalesce(h.closed,true) AS closed,h.open_minute,h.close_minute,'+
      'EXISTS(SELECT 1 FROM tala_restaurants_v2.branch_closures e '+
      'WHERE e.branch_id=b.id AND e.store_id=s.id '+
      'AND e.cancelled_at IS NULL AND e.starts_at<=$3::timestamptz '+
      'AND e.ends_at>$3::timestamptz) AS exception_closed,'+
      '(extract(hour from ($3::timestamptz AT TIME ZONE \'America/Mexico_City\'))::int*60+'+
      'extract(minute from ($3::timestamptz AT TIME ZONE \'America/Mexico_City\'))::int) AS local_minute '+
      'FROM tala_restaurants_v2.stores s JOIN tala_restaurants_v2.branches b '+
      'ON b.store_id=s.id LEFT JOIN tala_restaurants_v2.hours h '+
      'ON h.branch_id=b.id AND h.weekday=extract(dow FROM '+
      '($3::timestamptz AT TIME ZONE \'America/Mexico_City\'))::int '+
      'WHERE s.id=$1::uuid AND b.id=$2::uuid',[store,branch,when]);
    const row=r.rows[0];
    if(!row)throw new RestaurantError('M6_BRANCH_NOT_FOUND');
    const scheduleOpen=!row.closed&&row.open_minute!==null&&
      row.close_minute!==null&&row.local_minute>=row.open_minute&&
      row.local_minute<row.close_minute;
    const open=row.status==='ready'&&row.is_active&&scheduleOpen&&
      !row.exception_closed;
    return Object.freeze({
      storeId:store,branchId:branch,timeZone:'America/Mexico_City',
      isOpen:open,pickupAvailable:open&&row.pickup_enabled,
      deliveryAvailable:open&&row.delivery_enabled,
      reason:row.status!=='ready'?'STORE_NOT_READY':
        !row.is_active?'BRANCH_PAUSED':
        row.exception_closed?'EXCEPTIONAL_CLOSURE':
        !scheduleOpen?'OUTSIDE_HOURS':'OPEN'
    });
  },true);
}
