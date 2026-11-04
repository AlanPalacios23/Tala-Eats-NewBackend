import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import {RestaurantError} from '../src/domain.js';
import {createStore,createBranch,changeStoreStatus,setStaffRole,
  setBranchHours,getBranchAvailability} from '../src/stores.js';
import {setBranchSchedule,readBranchSchedule} from '../src/schedule.js';
import {setBranchPreparation,readBranchPreparation} from '../src/preparation.js';
import {createProduct,createVariant,readOfferSnapshot} from '../src/catalog.js';
import {readBranchStorefront} from '../src/branch-catalog.js';
import {discoverReadyBranches} from '../src/discovery.js';
import {createRestaurantsLabHttpServer} from '../src/http-lab.js';

const url=process.env.RESTAURANTS_CI_URL??'';
const enabled=url.includes('/tala_restaurants_v2_test');
const id=()=>randomUUID();
const fail=(task:()=>Promise<unknown>,code:string)=>assert.rejects(task,
  (err:unknown)=>err instanceof RestaurantError&&err.code===code);

test('M6 LAB8 split/overnight schedule is consistent across all read contracts',
 {skip:!enabled,timeout:110000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:10});
  const owner={actorId:id()},editor={actorId:id()},other={actorId:id()};
  try{
    const shop=await createStore(pool,owner,{operationId:id(),
      slug:'lab8-nights-'+id().slice(0,12),name:'LAB8 Cocina Nocturna',
      kind:'restaurant'});
    const branch=await createBranch(pool,owner,{storeId:shop.id,operationId:id(),
      name:'Cocina Tala',address:'Calle Morelos 123, Tala',city:'tala',
      pickupEnabled:true,deliveryEnabled:true});
    const product=await createProduct(pool,owner,{storeId:shop.id,
      operationId:id(),name:'Tacos al pastor',category:'Comidas'});
    const variant=await createVariant(pool,owner,{storeId:shop.id,
      productId:product.id,operationId:id(),label:'Orden de 5',
      priceCents:10000,trackStock:true,stockQuantity:12});
    await setStaffRole(pool,owner,{storeId:shop.id,memberId:editor.actorId,role:'editor'});
    const schedule=await setBranchSchedule(pool,owner,{
      storeId:shop.id,branchId:branch.id,expectedVersion:1,days:[
        {weekday:1,closed:false,intervals:[
          {openMinute:540,closeMinute:720},
          {openMinute:840,closeMinute:1140}
        ]},
        {weekday:2,closed:false,intervals:[
          {openMinute:1200,closeMinute:120}
        ]}
      ]});
    assert.equal(schedule.version,2);
    await changeStoreStatus(pool,owner,{storeId:shop.id,
      expectedVersion:1,status:'ready'});
    const at=(iso:string)=>new Date(iso);
    const sample=async(iso:string)=>{
      const when=at(iso);
      const status=await getBranchAvailability(pool,{storeId:shop.id,
        branchId:branch.id,at:when});
      const storefront=await readBranchStorefront(pool,{storeId:shop.id,
        branchId:branch.id,at:when});
      const offer=await readOfferSnapshot(pool,{storeId:shop.id,
        branchId:branch.id,variantId:variant.id,at:when});
      const discovery=await discoverReadyBranches(pool,{city:'tala',
        search:'LAB8 Cocina Nocturna',at:when});
      const listing=discovery.items.find(x=>x.branchId===branch.id);
      assert.ok(listing);
      assert.equal(status.isOpen,storefront.open);
      assert.equal(status.isOpen,offer.available);
      assert.equal(status.isOpen,listing.open);
      return status.isOpen;
    };
    assert.equal(await sample('2026-11-02T16:00:00Z'),true); // Monday 10:00
    assert.equal(await sample('2026-11-02T19:00:00Z'),false); // Monday 13:00
    assert.equal(await sample('2026-11-02T21:00:00Z'),true); // Monday 15:00
    assert.equal(await sample('2026-11-04T07:00:00Z'),true); // Wednesday 01:00 (Tuesday overnight)
    assert.equal(await sample('2026-11-04T08:00:00Z'),false); // Wednesday 02:00 exact close
    const read=await readBranchSchedule(pool,owner,{storeId:shop.id,branchId:branch.id});
    assert.equal(read.slots.length,3);
    assert.ok(read.slots.some(x=>x.weekday===2&&x.closeMinute===120&&x.closesNextDay));
    await fail(()=>setBranchSchedule(pool,editor,{
      storeId:shop.id,branchId:branch.id,expectedVersion:2,
      days:[{weekday:3,closed:true}]}),'M6_FORBIDDEN');
    await fail(()=>readBranchSchedule(pool,other,{
      storeId:shop.id,branchId:branch.id}),'M6_FORBIDDEN');
    await fail(()=>setBranchSchedule(pool,owner,{
      storeId:shop.id,branchId:branch.id,expectedVersion:2,
      days:[{weekday:3,closed:false,intervals:[
        {openMinute:60,closeMinute:300}
      ]}]}),'M6_SCHEDULE_OVERLAP');
    assert.equal((await readBranchSchedule(pool,owner,{storeId:shop.id,
      branchId:branch.id})).version,2); // transaction rolled back
    await fail(()=>setBranchSchedule(pool,owner,{
      storeId:shop.id,branchId:branch.id,expectedVersion:2,
      days:[{weekday:1,closed:false,intervals:[
        {openMinute:600,closeMinute:900},{openMinute:800,closeMinute:1000}
      ]}]}),'M6_SCHEDULE_OVERLAP');
    await fail(()=>setBranchSchedule(pool,owner,{
      storeId:shop.id,branchId:branch.id,expectedVersion:2,
      days:[{weekday:0,closed:false,intervals:[
        {openMinute:800,closeMinute:800}
      ]}]}),'M6_SCHEDULE_INVALID');

    const initial=await readBranchPreparation(pool,owner,{
      storeId:shop.id,branchId:branch.id});
    assert.equal(initial.prepMinutes,25);
    await fail(()=>setBranchPreparation(pool,editor,{
      storeId:shop.id,branchId:branch.id,expectedVersion:2,
      prepMinutes:20,parallelPrepSlots:8}),'M6_FORBIDDEN');
    await fail(()=>setBranchPreparation(pool,owner,{
      storeId:shop.id,branchId:branch.id,expectedVersion:2,
      prepMinutes:0,parallelPrepSlots:8}),'M6_PREPARATION_INVALID');
    const changed=await setBranchPreparation(pool,owner,{
      storeId:shop.id,branchId:branch.id,expectedVersion:2,
      prepMinutes:35,parallelPrepSlots:8});
    assert.equal(changed.version,3);
    assert.equal(changed.parallelPrepSlots,8);
    const reflected=await readBranchStorefront(pool,{
      storeId:shop.id,branchId:branch.id,
      at:at('2026-11-02T16:00:00Z')});
    assert.equal(reflected.prepMinutes,35);
    await fail(()=>setBranchPreparation(pool,owner,{
      storeId:shop.id,branchId:branch.id,expectedVersion:2,
      prepMinutes:40,parallelPrepSlots:10}),'M6_VERSION_CONFLICT');
    // Legacy one-slot API remains usable and updates the same canonical schedule.
    await setBranchHours(pool,owner,{storeId:shop.id,branchId:branch.id,
      expectedVersion:3,days:[{weekday:1,closed:false,
        openMinute:600,closeMinute:1080}]});
    assert.equal(await sample('2026-11-02T19:00:00Z'),true);
    assert.equal(await sample('2026-11-04T07:00:00Z'),true);
    // Saturday night must cross the weekly boundary into Sunday.
    const weekend=await setBranchSchedule(pool,owner,{
      storeId:shop.id,branchId:branch.id,expectedVersion:4,
      days:[
        {weekday:6,closed:false,intervals:[
          {openMinute:1200,closeMinute:120}
        ]},
        {weekday:4,closed:false,intervals:[
          {openMinute:1080,closeMinute:0}
        ]}
      ]});
    assert.equal(weekend.version,5);
    assert.equal(await sample('2026-11-08T07:00:00Z'),true); // Sunday 01:00 MX
    assert.equal(await sample('2026-11-08T08:00:00Z'),false); // Sunday 02:00 MX
    const midnight=(await readBranchSchedule(pool,owner,{
      storeId:shop.id,branchId:branch.id})).slots.find(x=>x.weekday===4)!;
    assert.equal(midnight.closeMinute,0);
    assert.equal(midnight.closesNextDay,true);
    await fail(()=>setBranchSchedule(pool,owner,{
      storeId:shop.id,branchId:branch.id,expectedVersion:5,
      days:[{weekday:0,closed:false,intervals:[
        {openMinute:60,closeMinute:300}
      ]}]}),'M6_SCHEDULE_OVERLAP');
    assert.equal((await readBranchSchedule(pool,owner,{
      storeId:shop.id,branchId:branch.id})).version,5);
    const audit=await pool.query<{action:string}>(
      'SELECT action FROM tala_restaurants_v2.audit WHERE store_id=$1::uuid',
      [shop.id]);
    assert.ok(audit.rows.some(x=>x.action==='branch.schedule'));
    assert.ok(audit.rows.some(x=>x.action==='branch.preparation'));
  }finally{await pool.end();}
});

test('M6 LAB8 HTTP endpoints enforce host identity and tenant RBAC',
 {skip:!enabled,timeout:70000},async()=>{
  const pool=new pg.Pool({connectionString:url,max:8});
  const owner={actorId:id()},other={actorId:id()};
  const ownToken='owner-'+id(),otherToken='other-'+id();
  const server=createRestaurantsLabHttpServer({pool,
    authenticate:async req=>req.headers.authorization==='Bearer '+ownToken?owner:
      req.headers.authorization==='Bearer '+otherToken?other:null});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  async function call(method:string,path:string,token:string,data?:unknown){
    const res=await fetch(base+path,{method,headers:{
      authorization:'Bearer '+token,
      ...(data===undefined?{}:{'content-type':'application/json'})
    },...(data===undefined?{}:{body:JSON.stringify(data)})});
    return {status:res.status,data:await res.json() as Record<string,any>};
  }
  try{
    const shop=await createStore(pool,owner,{operationId:id(),
      slug:'lab8-http-'+id().slice(0,12),name:'M6 HTTP Cocina',kind:'restaurant'});
    const branch=await createBranch(pool,owner,{storeId:shop.id,operationId:id(),
      name:'Cocina Centro',address:'Juárez 123, Tala',city:'tala',
      pickupEnabled:true,deliveryEnabled:false});
    const path='/v1/restaurants/'+shop.id+'/branches/'+branch.id;
    assert.equal((await call('GET',path+'/schedule',otherToken)).status,403);
    assert.equal((await call('GET',path+'/preparation',ownToken)).status,200);
    const write=await call('PUT',path+'/schedule',ownToken,{expectedVersion:1,
      days:[{weekday:1,closed:false,intervals:[
        {openMinute:540,closeMinute:720},
        {openMinute:840,closeMinute:1100}
      ]}]});
    assert.equal(write.status,200);
    assert.equal(write.data.version,2);
    assert.equal((await call('GET',path+'/schedule',ownToken)).data.slots.length,2);
    const cap=await call('PUT',path+'/preparation',ownToken,{
      expectedVersion:2,prepMinutes:30,parallelPrepSlots:6});
    assert.equal(cap.status,200);
    assert.equal(cap.data.version,3);
    assert.equal((await call('PUT',path+'/preparation',ownToken,{
      expectedVersion:2,prepMinutes:30,parallelPrepSlots:6})).status,409);
    assert.equal((await call('PUT',path+'/preparation',otherToken,{
      expectedVersion:3,prepMinutes:40,parallelPrepSlots:7})).status,403);
  }finally{
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await pool.end();
  }
});
