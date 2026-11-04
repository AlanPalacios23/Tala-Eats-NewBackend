/** M6-only schedules. Slots are local minutes in America/Mexico_City.
 * A closeMinute less than openMinute closes the following local day.
 * No orders, drivers, customer notifications or payment dependencies.
 */
import type {Pool,PoolClient} from 'pg';
import {RestaurantError,person,uuid,integer,type Actor} from './domain.js';
import {tx,access,audit} from './db.js';

export type ScheduleDay={
  weekday:number,closed:boolean,
  intervals?:Array<{openMinute:number,closeMinute:number}>
};
type Slot={weekday:number,slot:number,open_minute:number,close_minute:number};
const WEEK=7*1440;

function normalize(days:ScheduleDay[]){
  if(!Array.isArray(days)||days.length===0||days.length>7)
    throw new RestaurantError('M6_SCHEDULE_INVALID');
  const used=new Set<number>();
  const normalized:Array<{weekday:number,slots:Array<{open:number,close:number}>}>=[];
  for(const day of days){
    if(!day||typeof day!=='object'||Array.isArray(day))
      throw new RestaurantError('M6_SCHEDULE_INVALID');
    const weekday=integer(day.weekday,0,6,'M6_SCHEDULE_INVALID');
    if(used.has(weekday)||typeof day.closed!=='boolean')
      throw new RestaurantError('M6_SCHEDULE_INVALID');
    used.add(weekday);
    const list=day.intervals??[];
    if(!Array.isArray(list)||list.length>(day.closed?0:4)||
       (!day.closed&&list.length===0))
      throw new RestaurantError('M6_SCHEDULE_INVALID');
    const slots=day.closed?[]:list.map(interval=>{
      if(!interval||typeof interval!=='object'||Array.isArray(interval))
        throw new RestaurantError('M6_SCHEDULE_INVALID');
      const open=integer(interval.openMinute,0,1439,'M6_SCHEDULE_INVALID');
      const closeLocal=integer(interval.closeMinute,0,1440,'M6_SCHEDULE_INVALID');
      if(open===closeLocal)throw new RestaurantError('M6_SCHEDULE_INVALID');
      const close=closeLocal<=open?closeLocal+1440:closeLocal;
      if(close<=open||close-open>1440)
        throw new RestaurantError('M6_SCHEDULE_INVALID');
      return {open,close};
    });
    slots.sort((a,b)=>a.open-b.open);
    normalized.push({weekday,slots});
  }
  return normalized;
}

/** Checks collisions across all seven days, including Saturday -> Sunday. */
export async function assertScheduleConsistency(c:PoolClient,branch:string){
  const result=await c.query<Slot>(
    'SELECT weekday,slot,open_minute,close_minute '+
    'FROM tala_restaurants_v2.branch_schedule_slots WHERE branch_id=$1::uuid',
    [branch]);
  const absolute=result.rows.map(x=>({
    start:x.weekday*1440+x.open_minute,
    end:x.weekday*1440+x.close_minute
  })).sort((a,b)=>a.start-b.start);
  for(let i=1;i<absolute.length;i++){
    if(absolute[i]!.start<absolute[i-1]!.end)
      throw new RestaurantError('M6_SCHEDULE_OVERLAP');
  }
  if(absolute.length>1&&
     absolute[absolute.length-1]!.end>absolute[0]!.start+WEEK)
    throw new RestaurantError('M6_SCHEDULE_OVERLAP');
  if(absolute.length===1&&absolute[0]!.end-absolute[0]!.start>1440)
    throw new RestaurantError('M6_SCHEDULE_OVERLAP');
}

export async function setBranchSchedule(pool:Pool,actor:Actor,input:{
 storeId:string,branchId:string,expectedVersion:number,days:ScheduleDay[]
}){
  const user=person(actor),store=uuid(input.storeId),branch=uuid(input.branchId);
  const version=integer(input.expectedVersion,1,2147483646,'M6_VERSION_INVALID');
  const days=normalize(input.days);
  return tx(pool,async c=>{
    await access(c,store,user,['owner','manager'],true);
    const updated=await c.query<{version:number}>(
      'UPDATE tala_restaurants_v2.branches SET version=version+1,'+
      'updated_at=clock_timestamp() WHERE id=$1::uuid AND store_id=$2::uuid '+
      'AND version=$3 RETURNING version',[branch,store,version]);
    if(!updated.rows[0])throw new RestaurantError('M6_VERSION_CONFLICT');
    for(const day of days){
      await c.query('DELETE FROM tala_restaurants_v2.branch_schedule_slots '+
        'WHERE branch_id=$1::uuid AND weekday=$2',[branch,day.weekday]);
      for(const [slotIndex,slot] of day.slots.entries()){
        await c.query(
          'INSERT INTO tala_restaurants_v2.branch_schedule_slots '+
          '(branch_id,weekday,slot,open_minute,close_minute) '+
          'VALUES($1::uuid,$2,$3,$4,$5)',
          [branch,day.weekday,slotIndex,slot.open,slot.close]);
      }
      // Compatibility: old one-slot hours cannot represent multi/night windows.
      const compatible=day.slots.length===1&&day.slots[0]!.close<=1440;
      const first=compatible?day.slots[0]!:null;
      await c.query(
        'INSERT INTO tala_restaurants_v2.hours '+
        '(branch_id,weekday,closed,open_minute,close_minute) '+
        'VALUES($1::uuid,$2,$3,$4,$5) '+
        'ON CONFLICT(branch_id,weekday) DO UPDATE SET '+
        'closed=EXCLUDED.closed,open_minute=EXCLUDED.open_minute,'+
        'close_minute=EXCLUDED.close_minute,updated_at=clock_timestamp()',
        [branch,day.weekday,!compatible,first?.open??null,first?.close??null]);
    }
    await assertScheduleConsistency(c,branch);
    await audit(c,store,user,'branch.schedule',branch);
    return Object.freeze({branchId:branch,version:updated.rows[0].version,
      updatedDays:days.length});
  });
}

export async function readBranchSchedule(pool:Pool,actor:Actor,input:{
 storeId:string,branchId:string
}){
  const user=person(actor),store=uuid(input.storeId),branch=uuid(input.branchId);
  return tx(pool,async c=>{
    await access(c,store,user);
    const r=await c.query<{version:number}>(
      'SELECT version FROM tala_restaurants_v2.branches '+
      'WHERE id=$1::uuid AND store_id=$2::uuid',[branch,store]);
    if(!r.rows[0])throw new RestaurantError('M6_BRANCH_NOT_FOUND');
    const slots=await c.query<Slot>(
      'SELECT weekday,slot,open_minute,close_minute '+
      'FROM tala_restaurants_v2.branch_schedule_slots '+
      'WHERE branch_id=$1::uuid ORDER BY weekday,slot',[branch]);
    return Object.freeze({branchId:branch,version:r.rows[0].version,
      timeZone:'America/Mexico_City',
      slots:Object.freeze(slots.rows.map(x=>Object.freeze({
        weekday:x.weekday,slot:x.slot,openMinute:x.open_minute,
        closeMinute:x.close_minute>1440?x.close_minute-1440:x.close_minute,
        closesNextDay:x.close_minute>1440
      })))});
  },true);
}
