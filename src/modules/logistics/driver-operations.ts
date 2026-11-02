/**
 * TALA EATS CORE v2 — Logistics LAB1. Never enabled by the Render/public gate.
 * Latest GPS only: no location history, no customer disclosure and no fake ETA.
 */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';

export class LogisticsError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.code=code;this.name='LogisticsError';}
}
const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyPattern=/^[A-Za-z0-9_.:-]{16,128}$/;
type Profile={account_id:string;is_online:boolean;presence_version:string;approved:boolean;dispatch_heartbeat_at:Date|null};
type LocationRow={latitude_micro:number;longitude_micro:number;accuracy_m:number;
  sequence:string;observed_at:Date;received_at:Date};
async function tx(client:PoolClient){
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='3000ms'");
  await client.query("SET LOCAL statement_timeout='10000ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
}
async function lockProfile(client:PoolClient,id:string):Promise<Profile>{
  const r=await client.query<Profile>(`
    SELECT p.account_id,p.is_online,p.presence_version,p.approved,p.dispatch_heartbeat_at
    FROM tala_core_v2.driver_profiles p
    JOIN tala_core_v2.accounts a ON a.id=p.account_id
    WHERE p.account_id=$1::uuid AND p.approved=true
      AND a.is_active=true AND a.role='driver'
    FOR UPDATE OF p FOR SHARE OF a`,[id]);
  if(!r.rows[0])throw new LogisticsError('DRIVER_NOT_AVAILABLE');
  return r.rows[0];
}
async function hasActive(client:Pick<Pool,'query'>,id:string):Promise<boolean>{
  const r=await client.query(`
    SELECT 1 FROM tala_core_v2.order_driver_assignments d
    JOIN tala_core_v2.orders o ON o.id=d.order_id
    WHERE d.driver_id=$1::uuid
      AND o.status IN ('assigned','picked_up','on_the_way')
    LIMIT 1`,[id]);
  return !!r.rowCount;
}
export async function getDriverLogistics(pool:Pool,driverId:string){
  if(!idPattern.test(driverId))throw new LogisticsError('DRIVER_INVALID');
  const p=await pool.query<Profile>(`
    SELECT p.account_id,p.is_online,p.presence_version,p.approved,p.dispatch_heartbeat_at
    FROM tala_core_v2.driver_profiles p
    JOIN tala_core_v2.accounts a ON a.id=p.account_id
    WHERE p.account_id=$1::uuid AND p.approved=true
      AND a.is_active=true AND a.role='driver'`,[driverId]);
  if(!p.rows[0])throw new LogisticsError('DRIVER_NOT_AVAILABLE');
  const active=await pool.query<{count:string}>(`
    SELECT count(*)::text AS count FROM tala_core_v2.order_driver_assignments d
    JOIN tala_core_v2.orders o ON o.id=d.order_id
    WHERE d.driver_id=$1::uuid AND o.status IN ('assigned','picked_up','on_the_way')`,[driverId]);
  const pending=await pool.query<{count:string}>(`
    SELECT count(*)::text AS count FROM tala_core_v2.dispatch_offers
    WHERE driver_id=$1::uuid AND state='offered'`,[driverId]);
  const pendingOffers=Number(pending.rows[0]?.count??0);
  const loc=await pool.query<{received_at:Date}>(`
    SELECT received_at FROM tala_core_v2.driver_latest_locations
    WHERE driver_id=$1::uuid`,[driverId]);
  const age=loc.rows[0]?Math.max(0,Math.floor((Date.now()-new Date(loc.rows[0].received_at).getTime())/1000)):null;
  const hb=p.rows[0].dispatch_heartbeat_at;
  const heartbeatFresh=hb!==null&&Date.now()-new Date(hb).getTime()<=90000;
  return {online:p.rows[0].is_online,presenceVersion:p.rows[0].presence_version,
    dispatchEligible:p.rows[0].is_online&&heartbeatFresh&&Number(active.rows[0]?.count??0)===0&&pendingOffers===0,
    pendingOffers,activeDeliveries:Number(active.rows[0]?.count??0),capacity:1,
    locationFresh:age!==null&&age<=120,locationAgeSeconds:age};
}
type Presence={online:boolean;expectedVersion:bigint;commandKey:string};
export async function changeDriverPresence(pool:Pool,id:string,input:Presence){
  if(!idPattern.test(id)||typeof input.online!=='boolean'||
     !keyPattern.test(input.commandKey)||typeof input.expectedVersion!=='bigint'||
     input.expectedVersion<1n)throw new LogisticsError('PRESENCE_INVALID');
  const key=createHash('sha256').update(['driver.presence.v1',id.toLowerCase(),input.commandKey].join('|')).digest('hex');
  const client=await pool.connect();
  try{
    await tx(client);
    const profile=await lockProfile(client,id);
    const prev=await client.query<{desired_online:boolean;expected_version:string;result_version:string}>(`
      SELECT desired_online,expected_version,result_version
      FROM tala_core_v2.driver_presence_commands
      WHERE driver_id=$1::uuid AND command_hash=$2`,[id,key]);
    if(prev.rows[0]){
      const row=prev.rows[0];
      if(row.desired_online!==input.online||BigInt(row.expected_version)!==input.expectedVersion)
        throw new LogisticsError('IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT');
      return {online:row.desired_online,presenceVersion:row.result_version,replayed:true};
    }
    if(BigInt(profile.presence_version)!==input.expectedVersion)
      throw new LogisticsError('PRESENCE_VERSION_CONFLICT');
    if(!input.online&&await hasActive(client,id))
      throw new LogisticsError('ACTIVE_DELIVERY_MUST_FINISH');
    const updated=await client.query<{presence_version:string}>(`
      UPDATE tala_core_v2.driver_profiles
      SET is_online=$2,presence_version=presence_version+1,presence_updated_at=now(),
        dispatch_heartbeat_at=NULL
      WHERE account_id=$1::uuid RETURNING presence_version`,[id,input.online]);
    const version=updated.rows[0]!.presence_version;
    await client.query(`
      INSERT INTO tala_core_v2.driver_presence_commands
        (driver_id,command_hash,expected_version,result_version,desired_online)
      VALUES($1::uuid,$2,$3::bigint,$4::bigint,$5)`,
      [id,key,String(input.expectedVersion),version,input.online]);
    if(!input.online)await client.query(
      'DELETE FROM tala_core_v2.driver_latest_locations WHERE driver_id=$1::uuid',[id]);
    await client.query(`
      INSERT INTO tala_core_v2.outbox(aggregate_id,event_key,event_type,payload)
      VALUES($1::uuid,$2,'driver.presence.changed',$3::jsonb)`,
      [id,key,JSON.stringify({driverId:id,online:input.online,version})]);
    await client.query('COMMIT');
    return {online:input.online,presenceVersion:version,replayed:false};
  }catch(e){await client.query('ROLLBACK');throw e;}
  finally{client.release();}
}
type Fix={latitude:number;longitude:number;accuracyMeters:number;sequence:bigint;observedAt:string};
const distMeters=(a:number,b:number,c:number,d:number)=>{
  const rad=Math.PI/180;
  const q=Math.sin((c-a)*rad/2)**2+Math.cos(a*rad)*Math.cos(c*rad)*Math.sin((d-b)*rad/2)**2;
  return 12742000*Math.asin(Math.min(1,Math.sqrt(q)));
};
export async function recordDriverLocation(pool:Pool,id:string,fix:Fix){
  const at=new Date(fix.observedAt);
  const ms=at.getTime(),now=Date.now();
  if(!idPattern.test(id)||!Number.isFinite(fix.latitude)||Math.abs(fix.latitude)>90||
    !Number.isFinite(fix.longitude)||Math.abs(fix.longitude)>180||
    !Number.isInteger(fix.accuracyMeters)||fix.accuracyMeters<1||fix.accuracyMeters>100||
    typeof fix.sequence!=='bigint'||fix.sequence<=0n||fix.sequence>9223372036854775807n||
    !Number.isFinite(ms)||ms<now-120000||ms>now+15000)
    throw new LogisticsError('LOCATION_INVALID');
  const lat=Math.round(fix.latitude*1e6),lon=Math.round(fix.longitude*1e6);
  const client=await pool.connect();
  try{
    await tx(client);
    const p=await lockProfile(client,id);
    if(!p.is_online||!await hasActive(client,id))
      throw new LogisticsError('LOCATION_REQUIRES_ACTIVE_DELIVERY');
    const previous=await client.query<LocationRow>(`
      SELECT latitude_micro,longitude_micro,accuracy_m,sequence,observed_at,received_at
      FROM tala_core_v2.driver_latest_locations
      WHERE driver_id=$1::uuid FOR UPDATE`,[id]);
    const old=previous.rows[0];
    if(old){
      const oldSeq=BigInt(old.sequence);
      if(fix.sequence===oldSeq){
        if(old.latitude_micro!==lat||old.longitude_micro!==lon||
          old.accuracy_m!==fix.accuracyMeters||
          new Date(old.observed_at).getTime()!==ms)
          throw new LogisticsError('LOCATION_SEQUENCE_CONFLICT');
        await client.query('COMMIT');
        return {accepted:true,sequence:String(fix.sequence),replayed:true};
      }
      if(fix.sequence<oldSeq||ms<=new Date(old.observed_at).getTime())
        throw new LogisticsError('LOCATION_SEQUENCE_STALE');
      if(now-new Date(old.received_at).getTime()<2000)
        throw new LogisticsError('LOCATION_RATE_LIMITED');
      const seconds=(ms-new Date(old.observed_at).getTime())/1000;
      const meters=distMeters(old.latitude_micro/1e6,old.longitude_micro/1e6,lat/1e6,lon/1e6);
      if(meters>seconds*70+200)throw new LogisticsError('LOCATION_IMPLAUSIBLE');
    }
    await client.query(`
      INSERT INTO tala_core_v2.driver_latest_locations
        (driver_id,latitude_micro,longitude_micro,accuracy_m,sequence,observed_at)
      VALUES($1::uuid,$2,$3,$4,$5::bigint,$6::timestamptz)
      ON CONFLICT(driver_id) DO UPDATE SET
        latitude_micro=EXCLUDED.latitude_micro,longitude_micro=EXCLUDED.longitude_micro,
        accuracy_m=EXCLUDED.accuracy_m,sequence=EXCLUDED.sequence,
        observed_at=EXCLUDED.observed_at,received_at=now()`,
      [id,lat,lon,fix.accuracyMeters,String(fix.sequence),at.toISOString()]);
    await client.query('COMMIT');
    return {accepted:true,sequence:String(fix.sequence),replayed:false};
  }catch(e){await client.query('ROLLBACK');throw e;}
  finally{client.release();}
}

/** Authenticated approved online drivers refresh a server-time heartbeat, no GPS. */
export async function heartbeatDriver(pool:Pool,id:string){
  if(!idPattern.test(id))throw new LogisticsError('DRIVER_INVALID');
  const r=await pool.query(`
    UPDATE tala_core_v2.driver_profiles p
    SET dispatch_heartbeat_at=now()
    FROM tala_core_v2.accounts a
    WHERE p.account_id=$1::uuid AND a.id=p.account_id
      AND a.is_active=true AND a.role='driver'
      AND p.approved=true AND p.is_online=true
      AND (p.dispatch_heartbeat_at IS NULL
        OR p.dispatch_heartbeat_at<=now()-interval '10 seconds')
    RETURNING p.dispatch_heartbeat_at`,[id]);
  if(r.rows[0])return {online:true,accepted:true,expiresInSeconds:90};
  const active=await pool.query(`
    SELECT 1 FROM tala_core_v2.driver_profiles p
    JOIN tala_core_v2.accounts a ON a.id=p.account_id
    WHERE p.account_id=$1::uuid AND a.is_active=true AND a.role='driver'
      AND p.approved=true AND p.is_online=true`,[id]);
  if(!active.rowCount)throw new LogisticsError('DRIVER_NOT_AVAILABLE');
  return {online:true,accepted:false,expiresInSeconds:90};
}
