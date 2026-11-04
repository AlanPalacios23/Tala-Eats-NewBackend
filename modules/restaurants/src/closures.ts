/** Independent M6 branch-specific exceptional closures.
 * Operational windows only, not order cancellations or dispatch events.
 */
import type {Pool} from 'pg';
import {RestaurantError,uuid,person,member,digest,type Actor} from './domain.js';
import {tx,access,audit,claim,complete} from './db.js';
const REASONS=['holiday','maintenance','emergency','other'] as const;
type ClosureReason=(typeof REASONS)[number];
function instant(value:unknown):Date{
  if(typeof value!=='string'||
     !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    throw new RestaurantError('M6_CLOSURE_TIME_INVALID');
  const parsed=new Date(value);
  if(!Number.isFinite(parsed.getTime())||parsed.toISOString()!==value)
    throw new RestaurantError('M6_CLOSURE_TIME_INVALID');
  return parsed;
}
export async function scheduleBranchClosure(pool:Pool,actor:Actor,input:{
  storeId:string,branchId:string,operationId:string,
  startsAt:string,endsAt:string,reason:ClosureReason
}){
  const user=person(actor),store=uuid(input.storeId),branch=uuid(input.branchId);
  const operation=uuid(input.operationId);
  const starts=instant(input.startsAt),ends=instant(input.endsAt);
  const reason=member(input.reason,REASONS,'M6_CLOSURE_REASON_INVALID');
  const duration=ends.getTime()-starts.getTime();
  if(duration<=0||duration>31*86400000)
    throw new RestaurantError('M6_CLOSURE_RANGE_INVALID');
  const fingerprint=digest({store,branch,
    startsAt:starts.toISOString(),endsAt:ends.toISOString(),reason});
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager'],true);
    // The parent store row is locked to serialize schedule/overlap mutations
    // across concurrent managers and processes.
    const old=await claim(c,user,operation,'closure.create',fingerprint);
    if(old)return {id:old,replayed:true};
    const matched=await c.query(
      'SELECT id FROM tala_restaurants_v2.branches '+
      'WHERE id=$1::uuid AND store_id=$2::uuid',[branch,store]);
    if(!matched.rowCount)throw new RestaurantError('M6_BRANCH_NOT_FOUND');
    const overlap=await c.query(
      'SELECT id FROM tala_restaurants_v2.branch_closures '+
      'WHERE branch_id=$1::uuid AND store_id=$2::uuid '+
      'AND cancelled_at IS NULL AND starts_at<$4 AND ends_at>$3 LIMIT 1',
      [branch,store,starts,ends]);
    if(overlap.rowCount)throw new RestaurantError('M6_CLOSURE_OVERLAP');
    const saved=await c.query<{id:string}>(
      'INSERT INTO tala_restaurants_v2.branch_closures '+
      '(store_id,branch_id,actor_id,starts_at,ends_at,reason) '+
      'VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6) RETURNING id',
      [store,branch,user,starts,ends,reason]);
    const id=saved.rows[0]!.id;
    await audit(c,store,user,'branch.closure.create',id);
    await complete(c,user,operation,id);
    return {id,replayed:false};
  });
}
export async function cancelBranchClosure(pool:Pool,actor:Actor,input:{
  storeId:string,branchId:string,closureId:string
}){
  const user=person(actor),store=uuid(input.storeId),branch=uuid(input.branchId);
  const id=uuid(input.closureId);
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager'],true);
    const r=await c.query(
      'UPDATE tala_restaurants_v2.branch_closures '+
      'SET cancelled_at=clock_timestamp(),cancelled_by=$4::uuid '+
      'WHERE id=$1::uuid AND branch_id=$2::uuid AND store_id=$3::uuid '+
      'AND cancelled_at IS NULL',
      [id,branch,store,user]);
    if(r.rowCount===1)
      await audit(c,store,user,'branch.closure.cancel',id);
    return {id,cancelled:r.rowCount===1};
  });
}
export async function listBranchClosures(pool:Pool,actor:Actor,input:{
  storeId:string,branchId:string
}){
  const user=person(actor),store=uuid(input.storeId),branch=uuid(input.branchId);
  return tx(pool,async c=>{
    await access(c,store,user);
    const branchExists=await c.query(
      'SELECT id FROM tala_restaurants_v2.branches '+
      'WHERE id=$1::uuid AND store_id=$2::uuid',[branch,store]);
    if(!branchExists.rowCount)throw new RestaurantError('M6_BRANCH_NOT_FOUND');
    const result=await c.query(
      'SELECT id,starts_at,ends_at,reason,created_at,cancelled_at '+
      'FROM tala_restaurants_v2.branch_closures '+
      'WHERE store_id=$1::uuid AND branch_id=$2::uuid '+
      'ORDER BY starts_at DESC,id DESC LIMIT 100',[store,branch]);
    return {closures:result.rows};
  },true);
}
