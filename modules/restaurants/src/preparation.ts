/** M6-only operational preparation preferences, not live order admission. */
import type {Pool} from 'pg';
import {RestaurantError,person,uuid,integer,type Actor} from './domain.js';
import {tx,access,audit} from './db.js';

export async function setBranchPreparation(pool:Pool,actor:Actor,input:{
 storeId:string,branchId:string,expectedVersion:number,
 prepMinutes:number,parallelPrepSlots:number
}){
  const user=person(actor),store=uuid(input.storeId),branch=uuid(input.branchId);
  const version=integer(input.expectedVersion,1,2147483646,'M6_VERSION_INVALID');
  const prep=integer(input.prepMinutes,5,240,'M6_PREPARATION_INVALID');
  const slots=integer(input.parallelPrepSlots,1,100,'M6_PREPARATION_INVALID');
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager'],true);
    const result=await c.query<{
      version:number,prep_minutes:number,parallel_prep_slots:number
    }>(
      'UPDATE tala_restaurants_v2.branches SET prep_minutes=$4,'+
      'parallel_prep_slots=$5,version=version+1,'+
      'updated_at=clock_timestamp() WHERE id=$1::uuid AND store_id=$2::uuid '+
      'AND version=$3 RETURNING version,prep_minutes,parallel_prep_slots',
      [branch,store,version,prep,slots]);
    if(!result.rows[0])throw new RestaurantError('M6_VERSION_CONFLICT');
    await audit(c,store,user,'branch.preparation',branch);
    return Object.freeze({
      branchId:branch,version:result.rows[0].version,
      prepMinutes:result.rows[0].prep_minutes,
      parallelPrepSlots:result.rows[0].parallel_prep_slots
    });
  });
}
export async function readBranchPreparation(pool:Pool,actor:Actor,input:{
 storeId:string,branchId:string
}){
  const user=person(actor),store=uuid(input.storeId),branch=uuid(input.branchId);
  return tx(pool,async c=>{
    await access(c,store,user);
    const r=await c.query<{
      version:number,prep_minutes:number,parallel_prep_slots:number
    }>(
      'SELECT version,prep_minutes,parallel_prep_slots '+
      'FROM tala_restaurants_v2.branches WHERE id=$1::uuid AND store_id=$2::uuid',
      [branch,store]);
    if(!r.rows[0])throw new RestaurantError('M6_BRANCH_NOT_FOUND');
    return Object.freeze({branchId:branch,version:r.rows[0].version,
      prepMinutes:r.rows[0].prep_minutes,
      parallelPrepSlots:r.rows[0].parallel_prep_slots});
  },true);
}
