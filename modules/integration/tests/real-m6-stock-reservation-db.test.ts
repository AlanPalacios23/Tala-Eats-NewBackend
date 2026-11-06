import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {IntegrationError} from '../src/events.js';
import {reserveM6BranchStock,confirmM6BranchStock,releaseM6BranchStock,
 inspectM6StockHold,type ReserveInput} from '../m6-extension/reservations.js';
import {createReservedLabPickup,reconcileReservedLabIntent}
 from '../adapters/inventory-checkout-lab.js';
import {linkM6VariantToM1Catalog,
 type CatalogLabConfig,type LinkedPickupCart}
 from '../adapters/catalog-checkout-lab.js';
import {linkControlledCustomerAccounts}
 from '../adapters/order-ownership-lab.js';
import {createStore,createBranch,setBranchHours,changeStoreStatus}
 from '../../restaurants/src/stores.js';
import {createProduct,createVariant}
 from '../../restaurants/src/catalog.js';
import {enableBranchInventory,adjustBranchStock}
 from '../../restaurants/src/branch-stock.js';
import {registerCredentialedPendingUser,loginLabUser}
 from '../../users/src/auth.js';
import {issueLabEmailChallenge,verifyLabEmailChallenge}
 from '../../users/src/store.js';
import {createHmac} from 'node:crypto';
import {advanceLabPickupMerchant,issueLabPickupPin,
 attestLabPickupBuyerCash,attestLabPickupMerchantCash,finishLabPickup,
 relayVerifiedM1PickupOutbox,verifiedM1PickupEvents}
 from '../adapters/pickup-lifecycle-lab.js';
import {createRealM1PickupRecipientResolver,
 createM1PickupAnalyticsLabConsumer,recordRealM1PickupHeldFinance}
 from '../adapters/pickup-consumers-lab.js';
import {createM5NotificationLabConsumer}
 from '../adapters/notifications-lab.js';
import {deliverOnce} from '../src/bridge.js';
import {readInbox} from '../../notifications/src/store.js';
import {setRecipientPreference} from '../../notifications/src/recipients.js';
import {merchantAnalytics} from '../../analytics/src/analytics.js';
import type {IssuerKeys} from '../../analytics/src/contract.js';
import {StripeTestClient} from '../../payments/src/stripe-test-client.js';
import {ingestStripeTestWebhook}
 from '../../payments/src/stripe-test-webhook.js';
import {startStripeTestLabPickup,reconcileStripeTestLabPickup}
 from '../adapters/stripe-test-checkout-lab.js';
import {hashPassword,issueSession}
 from '../../../src/modules/orders/lab-auth.ts';
import {OrderServiceError} from '../../../src/modules/orders/checkout.ts';

const urls={
 integration:process.env.INTEGRATION_CI_URL??'',
 restaurants:process.env.RESTAURANTS_CI_URL??'',
 orders:process.env.CORE_CI_URL??'',
 users:process.env.USERS_CI_URL??''
};
const enabled=urls.integration.includes('/tala_integration_v2_test')&&
 urls.restaurants.includes('/tala_restaurants_v2_test')&&
 urls.orders.includes('/tala_core_v2_test')&&
 urls.users.includes('/tala_users_v2_test');
const id=()=>randomUUID();
const labStaff={authenticated:true,canLinkCatalog:true};
const password='Tala-M11-Lab6#2026-Strict';
const isError=(code:string)=>(err:unknown)=>
 err instanceof IntegrationError&&err.code===code;
function fixture(){
 const config:CatalogLabConfig={
  integrationPool:new pg.Pool({connectionString:urls.integration,max:14}),
  restaurantsPool:new pg.Pool({connectionString:urls.restaurants,max:16}),
  ordersPool:new pg.Pool({connectionString:urls.orders,max:14}),
  usersPool:new pg.Pool({connectionString:urls.users,max:14}),
  usersPasswordPepper:randomBytes(32)
 };
 return {config,close:()=>Promise.all([
  config.integrationPool.end(),config.restaurantsPool.end(),
  config.ordersPool.end(),config.usersPool.end()
 ])};
}
type Setup=Awaited<ReturnType<typeof setup>>;
async function setup(c:CatalogLabConfig,stock=4){
 const actor={actorId:id()};
 const store=await createStore(c.restaurantsPool,actor,{
  operationId:id(),slug:'m11-holds-'+id().slice(0,16),
  name:'Mercado de pruebas LAB6',kind:'greengrocer'});
 const branch=await createBranch(c.restaurantsPool,actor,{
  storeId:store.id,operationId:id(),name:'Tala Centro',
  address:'Laboratorio Sin Clientes 124, Tala',
  city:'tala',pickupEnabled:true,deliveryEnabled:false});
 await setBranchHours(c.restaurantsPool,actor,{
  storeId:store.id,branchId:branch.id,expectedVersion:1,
  days:Array.from({length:7},(_,weekday)=>({
   weekday,closed:false,openMinute:0,closeMinute:1440}))});
 const product=await createProduct(c.restaurantsPool,actor,{
  storeId:store.id,operationId:id(),name:'Jitomate saladet',
  category:'Verduras'});
 const variant=await createVariant(c.restaurantsPool,actor,{
  storeId:store.id,productId:product.id,operationId:id(),
  label:'500 g',weightGrams:500,priceCents:3500,
  stockQuantity:0,trackStock:true});
 const enabledBranch=await enableBranchInventory(c.restaurantsPool,actor,{
  storeId:store.id,variantId:variant.id,expectedVersion:1});
 assert.equal(enabledBranch.version,2);
 await adjustBranchStock(c.restaurantsPool,actor,{
  storeId:store.id,branchId:branch.id,variantId:variant.id,
  operationId:id(),delta:stock,reason:'restock'});
 await changeStoreStatus(c.restaurantsPool,actor,{
  storeId:store.id,expectedVersion:1,status:'ready'});
 const r=await c.ordersPool.query<{id:string}>(
  "INSERT INTO tala_core_v2.restaurants(name,is_open) VALUES('M1 LEGACY LAB6',true) RETURNING id");
 const restaurantId=r.rows[0]!.id;
 const p=await c.ordersPool.query<{id:string}>(
  'INSERT INTO tala_core_v2.catalog_products '+
  '(restaurant_id,name,price_minor,stock,is_available) '+
  "VALUES($1::uuid,'Jitomate saladet — 500 g',3500,$2,true) RETURNING id",
  [restaurantId,stock]);
 const m1ProductId=p.rows[0]!.id;
 await linkM6VariantToM1Catalog(c,labStaff,{
  storeId:store.id,branchId:branch.id,variantId:variant.id,
  m1RestaurantId:restaurantId,m1ProductId});
 const cart:LinkedPickupCart={storeId:store.id,branchId:branch.id,
  lines:[{variantId:variant.id,quantity:1,expectedVariantVersion:2}]};
 return {storeId:store.id,branchId:branch.id,variantId:variant.id,
  m1ProductId,restaurantId,cart,actor};
}
async function customer(c:CatalogLabConfig){
 const email='lab6.'+id()+'@example.test',mailSecret=randomBytes(32);
 const reg=await registerCredentialedPendingUser(c.usersPool,{
  email,displayName:'Cliente M11 LAB6',password,
  secret:c.usersPasswordPepper,idempotencyKey:id()});
 const challenge=await issueLabEmailChallenge(c.usersPool,{
  userId:reg.user.id,secret:mailSecret});
 await verifyLabEmailChallenge(c.usersPool,{
  userId:reg.user.id,actorId:reg.user.id,token:challenge.token,
  secret:mailSecret,expectedVersion:1,idempotencyKey:id()});
 const login=await loginLabUser(c.usersPool,{
  email,password,secret:c.usersPasswordPepper});
 const m1=await c.ordersPool.query<{id:string}>(
  'INSERT INTO tala_core_v2.accounts(email,display_name,password_hash,role) '+
  "VALUES($1,'Cliente LAB6',$2,'customer') RETURNING id",
  [email,await hashPassword(password)]);
 const m1Session=await issueSession(c.ordersPool,m1.rows[0]!.id);
 await linkControlledCustomerAccounts({
  integrationPool:c.integrationPool,usersPool:c.usersPool,
  ordersPool:c.ordersPool,usersPasswordPepper:c.usersPasswordPepper
 },{m4SessionToken:login.sessionToken,m1SessionToken:m1Session});
 return {m4Id:reg.user.id,sessionToken:login.sessionToken,buyerId:m1.rows[0]!.id};
}
async function physical(c:CatalogLabConfig,s:Setup){
 const [m6,m1]=await Promise.all([
  c.restaurantsPool.query<{quantity:number}>(
   'SELECT quantity FROM tala_restaurants_v2.branch_stock '+
   'WHERE branch_id=$1::uuid AND variant_id=$2::uuid',
   [s.branchId,s.variantId]),
  c.ordersPool.query<{stock:number}>(
   'SELECT stock FROM tala_core_v2.catalog_products WHERE id=$1::uuid',
   [s.m1ProductId])
 ]);
 return {m6:m6.rows[0]!.quantity,m1:m1.rows[0]!.stock};
}
async function record(c:CatalogLabConfig,holdId:string){
 const [events,intent]=await Promise.all([
  c.restaurantsPool.query<{event_type:string}>(
   'SELECT event_type FROM tala_restaurants_v2.order_stock_hold_events '+
   'WHERE hold_id=$1::uuid ORDER BY created_at,event_type',[holdId]),
  c.integrationPool.query<{state:string,m1_order_id:string|null}>(
   'SELECT state,m1_order_id FROM tala_integration_v2.inventory_checkout_intents '+
   'WHERE intent_id=$1::uuid',[holdId])
 ]);
 return {events:events.rows.map(x=>x.event_type),
  state:intent.rows[0]?.state,orderId:intent.rows[0]?.m1_order_id};
}

test('LAB6 M6 authoritative branch reservation + real M1 order commit, sequential stock and exact replay',
 {skip:!enabled,timeout:120000},async()=>{
 const f=fixture();
 try{
  const s=await setup(f.config,4),u=await customer(f.config);
  const key='lab6-success-'+id();
  const first=await createReservedLabPickup(f.config,{
   sessionToken:u.sessionToken,cart:s.cart,idempotencyKey:key});
  assert.equal(first.inventoryOwner,'m6_branch_stock');
  assert.equal(first.m6StockHeld,true);
  assert.equal(first.holdConfirmed,true);
  assert.equal(first.paymentConfirmed,false);
  assert.equal(first.policyApproved,false);
  assert.equal(first.commercialReady,false);
  assert.equal(first.replayed,false);
  assert.deepEqual(await physical(f.config,s),{m6:3,m1:3});
  const row=await record(f.config,first.holdId);
  assert.equal(row.state,'confirmed');
  assert.equal(row.orderId,first.orderId);
  assert.deepEqual(row.events,['inventory.reserved','inventory.confirmed']);
  const old=await createReservedLabPickup(f.config,{
   sessionToken:u.sessionToken,cart:s.cart,idempotencyKey:key});
  assert.equal(old.replayed,true);
  assert.equal(old.orderId,first.orderId);
  assert.deepEqual(await physical(f.config,s),{m6:3,m1:3});
  await assert.rejects(createReservedLabPickup(f.config,{
   sessionToken:u.sessionToken,
   cart:{...s.cart,lines:[{...s.cart.lines[0]!,quantity:2}]},
   idempotencyKey:key}),isError('M11_INTENT_IDEMPOTENCY_CONFLICT'));
  const next=await createReservedLabPickup(f.config,{
   sessionToken:u.sessionToken,cart:s.cart,
   idempotencyKey:'lab6-next-'+id()});
  assert.notEqual(next.orderId,first.orderId);
  assert.deepEqual(await physical(f.config,s),{m6:2,m1:2});
  const counts=await f.config.ordersPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_core_v2.orders '+
   'WHERE buyer_id=$1::uuid',[u.buyerId]);
  assert.equal(counts.rows[0]?.n,2);
 }finally{await f.close();}
});

test('LAB6 crash after M6 commit / before M1 checkout is resumed without double reserve',
 {skip:!enabled,timeout:120000},async()=>{
 const f=fixture();
 try{
  const s=await setup(f.config,3),u=await customer(f.config),
   key='lab6-after-hold-'+id();
  await assert.rejects(createReservedLabPickup(f.config,{
   sessionToken:u.sessionToken,cart:s.cart,idempotencyKey:key,
   labFaultAfter:'after_reservation'
  }),isError('M11_TEST_INJECTED_CRASH'));
  assert.deepEqual(await physical(f.config,s),{m6:2,m1:3});
  const intent=await f.config.integrationPool.query<{intent_id:string}>(
   'SELECT intent_id FROM tala_integration_v2.inventory_checkout_intents '+
   'WHERE buyer_m1_id=$1::uuid AND idempotency_key=$2',[u.buyerId,key]);
  const id1=intent.rows[0]!.intent_id;
  assert.equal((await inspectM6StockHold(f.config.restaurantsPool,id1))?.state,
   'reserved');
  const resumed=await createReservedLabPickup(f.config,{
   sessionToken:u.sessionToken,cart:s.cart,idempotencyKey:key
  });
  assert.equal(resumed.holdId,id1);
  assert.equal(resumed.replayed,false);
  assert.deepEqual(await physical(f.config,s),{m6:2,m1:2});
  assert.deepEqual((await record(f.config,id1)).events,
   ['inventory.reserved','inventory.confirmed']);
 }finally{await f.close();}
});

test('LAB6 crash after M1 COMMIT / before M6 ACK recovers without second order/stock debit',
 {skip:!enabled,timeout:120000},async()=>{
 const f=fixture();
 try{
  const s=await setup(f.config,3),u=await customer(f.config),
   key='lab6-after-m1-'+id();
  await assert.rejects(createReservedLabPickup(f.config,{
   sessionToken:u.sessionToken,cart:s.cart,idempotencyKey:key,
   labFaultAfter:'after_m1_commit'
  }),isError('M11_TEST_INJECTED_CRASH'));
  assert.deepEqual(await physical(f.config,s),{m6:2,m1:2});
  const result=await createReservedLabPickup(f.config,{
   sessionToken:u.sessionToken,cart:s.cart,idempotencyKey:key
  });
  assert.equal(result.replayed,true);
  assert.equal((await record(f.config,result.holdId)).state,'confirmed');
  const n=await f.config.ordersPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_core_v2.orders '+
   'WHERE buyer_id=$1::uuid',[u.buyerId]);
  assert.equal(n.rows[0]?.n,1);
  assert.deepEqual(await physical(f.config,s),{m6:2,m1:2});
 }finally{await f.close();}
});

test('LAB6 real M1 stock failure compensates M6; expired hold can release only after checking M1',
 {skip:!enabled,timeout:120000},async()=>{
 const f=fixture();
 try{
  const s=await setup(f.config,3),u=await customer(f.config),
   key='lab6-reject-m1-'+id();
  await assert.rejects(createReservedLabPickup(f.config,{
   sessionToken:u.sessionToken,cart:s.cart,idempotencyKey:key,
   labFaultAfter:'after_reservation'
  }),isError('M11_TEST_INJECTED_CRASH'));
  assert.deepEqual(await physical(f.config,s),{m6:2,m1:3});
  await f.config.ordersPool.query(
   'UPDATE tala_core_v2.catalog_products SET stock=0 WHERE id=$1::uuid',
   [s.m1ProductId]);
  await assert.rejects(createReservedLabPickup(f.config,{
   sessionToken:u.sessionToken,cart:s.cart,idempotencyKey:key
  }),e=>e instanceof OrderServiceError&&e.code==='OUT_OF_STOCK');
  assert.deepEqual(await physical(f.config,s),{m6:3,m1:0});
  const state=await f.config.integrationPool.query<{state:string,intent_id:string}>(
   'SELECT state,intent_id FROM tala_integration_v2.inventory_checkout_intents '+
   'WHERE buyer_m1_id=$1::uuid AND idempotency_key=$2',[u.buyerId,key]);
  assert.equal(state.rows[0]?.state,'released');
  const id1=state.rows[0]!.intent_id;
  assert.deepEqual((await record(f.config,id1)).events,
   ['inventory.reserved','inventory.released']);
  await assert.rejects(createReservedLabPickup(f.config,{
   sessionToken:u.sessionToken,cart:s.cart,idempotencyKey:key
  }),isError('M11_INTENT_RELEASED'));
  // No automatic expiry process can return stock by wall clock alone.
  await f.config.ordersPool.query(
   'UPDATE tala_core_v2.catalog_products SET stock=3 WHERE id=$1::uuid',
   [s.m1ProductId]);
  const key2='lab6-expire-'+id();
  await assert.rejects(createReservedLabPickup(f.config,{
   sessionToken:u.sessionToken,cart:s.cart,idempotencyKey:key2,
   labFaultAfter:'after_reservation'
  }),isError('M11_TEST_INJECTED_CRASH'));
  const hold=await f.config.integrationPool.query<{intent_id:string}>(
   'SELECT intent_id FROM tala_integration_v2.inventory_checkout_intents '+
   'WHERE buyer_m1_id=$1::uuid AND idempotency_key=$2',[u.buyerId,key2]);
  const holdId=hold.rows[0]!.intent_id;
  await f.config.restaurantsPool.query(
   "UPDATE tala_restaurants_v2.order_stock_holds SET expires_at=clock_timestamp()-interval '1 second' "+
   'WHERE hold_id=$1::uuid',[holdId]);
  const notYet=await reconcileReservedLabIntent(f.config,{
   sessionToken:u.sessionToken,cart:s.cart,idempotencyKey:key2,
   releaseIfExpired:false
  });
  assert.equal(notYet.state,'reserved');
  const expired=await reconcileReservedLabIntent(f.config,{
   sessionToken:u.sessionToken,cart:s.cart,idempotencyKey:key2,
   releaseIfExpired:true
  });
  assert.equal(expired.state,'released');
  assert.deepEqual(await physical(f.config,s),{m6:3,m1:3});
  assert.equal((await inspectM6StockHold(f.config.restaurantsPool,
   holdId))?.state,'released');
 }finally{await f.close();}
});

test('LAB6 competing customer checkout requests cannot oversell 1 physical unit',
 {skip:!enabled,timeout:120000},async()=>{
 const f=fixture();
 try{
  const s=await setup(f.config,1);
  const [a,b]=await Promise.all([customer(f.config),customer(f.config)]);
  const attempts=await Promise.allSettled([
   createReservedLabPickup(f.config,{sessionToken:a.sessionToken,
    cart:s.cart,idempotencyKey:'lab6-oversell-a-'+id()}),
   createReservedLabPickup(f.config,{sessionToken:b.sessionToken,
    cart:s.cart,idempotencyKey:'lab6-oversell-b-'+id()})
  ]);
  const success=attempts.filter(x=>x.status==='fulfilled');
  const failures=attempts.filter(x=>x.status==='rejected');
  assert.equal(success.length,1);
  assert.equal(failures.length,1);
  assert.deepEqual(await physical(f.config,s),{m6:0,m1:0});
  const orders=await f.config.ordersPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_core_v2.orders '+
   'WHERE restaurant_id=$1::uuid',[s.restaurantId]);
  assert.equal(orders.rows[0]?.n,1);
 }finally{await f.close();}
});

test('LAB6 direct M6 reservation: 8-way same-id replay, bounded stock, immutable events, confirmed hold cannot release',
 {skip:!enabled,timeout:120000},async()=>{
 const f=fixture();
 try{
  const s=await setup(f.config,3);
  const holdId=id();
  const input:ReserveInput={holdId,storeId:s.storeId,branchId:s.branchId,
   lines:[{variantId:s.variantId,quantity:1,expectedVersion:2,
    expectedPriceMinor:'3500',expectedName:'Jitomate saladet — 500 g'}],
   ttlSeconds:300};
  const results=await Promise.all(Array.from({length:8},()=>
   reserveM6BranchStock(f.config.restaurantsPool,input)));
  assert.equal(results.filter(x=>!x.replayed).length,1);
  assert.equal(results.filter(x=>x.replayed).length,7);
  assert.deepEqual(await physical(f.config,s),{m6:2,m1:3});
  await assert.rejects(reserveM6BranchStock(f.config.restaurantsPool,{
   ...input,lines:[{...input.lines[0]!,quantity:2}]
  }),isError('M11_HOLD_IDEMPOTENCY_CONFLICT'));
  const orderId=id();
  await confirmM6BranchStock(f.config.restaurantsPool,holdId,orderId);
  assert.equal((await confirmM6BranchStock(f.config.restaurantsPool,
   holdId,orderId)).replayed,true);
  await assert.rejects(releaseM6BranchStock(f.config.restaurantsPool,holdId),
   isError('M11_HOLD_ALREADY_CONFIRMED'));
  assert.deepEqual(await physical(f.config,s),{m6:2,m1:3});
  await assert.rejects(f.config.restaurantsPool.query(
   'DELETE FROM tala_restaurants_v2.order_stock_hold_events '+
   'WHERE hold_id=$1::uuid',[holdId]),
   /RESTAURANTS_STOCK_HISTORY_IMMUTABLE/);
  const events=await f.config.restaurantsPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_restaurants_v2.order_stock_hold_events '+
   'WHERE hold_id=$1::uuid',[holdId]);
  assert.equal(events.rows[0]?.n,2);
 }finally{await f.close();}
});

test('LAB6 expired reservation with existing committed M1 order must not restore units',
 {skip:!enabled,timeout:120000},async()=>{
 const f=fixture();
 try{
  const sample=await setup(f.config,2),buyer=await customer(f.config);
  const key='lab6-expired-committed-'+id();
  await assert.rejects(createReservedLabPickup(f.config,{
   sessionToken:buyer.sessionToken,cart:sample.cart,
   idempotencyKey:key,labFaultAfter:'after_m1_commit'
  }),isError('M11_TEST_INJECTED_CRASH'));
  const q=await f.config.integrationPool.query<{intent_id:string}>(
   'SELECT intent_id FROM tala_integration_v2.inventory_checkout_intents '+
   'WHERE buyer_m1_id=$1::uuid AND idempotency_key=$2',
   [buyer.buyerId,key]);
  const holdId=q.rows[0]!.intent_id;
  await f.config.restaurantsPool.query(
   "UPDATE tala_restaurants_v2.order_stock_holds SET "+
   "expires_at=clock_timestamp()-interval '1 second' "+
   "WHERE hold_id=$1::uuid",[holdId]);
  const done=await reconcileReservedLabIntent(f.config,{
   sessionToken:buyer.sessionToken,cart:sample.cart,
   idempotencyKey:key,releaseIfExpired:true
  });
  assert.equal(done.state,'confirmed');
  assert.deepEqual(await physical(f.config,sample),{m6:1,m1:1});
  await assert.rejects(releaseM6BranchStock(f.config.restaurantsPool,holdId),
   isError('M11_HOLD_ALREADY_CONFIRMED'));
 }finally{await f.close();}
});

test('LAB6 atomic multi-variant hold: failure on second line rolls back first stock debit',
 {skip:!enabled,timeout:120000},async()=>{
 const f=fixture();
 try{
  const sample=await setup(f.config,2);
  const p=await createProduct(f.config.restaurantsPool,sample.actor,{
   storeId:sample.storeId,operationId:id(),name:'Cebolla blanca',
   category:'Verduras'});
  const v=await createVariant(f.config.restaurantsPool,sample.actor,{
   storeId:sample.storeId,productId:p.id,operationId:id(),
   label:'1 kg',weightGrams:1000,priceCents:3000,
   stockQuantity:0,trackStock:true});
  await enableBranchInventory(f.config.restaurantsPool,sample.actor,{
   storeId:sample.storeId,variantId:v.id,expectedVersion:1});
  await adjustBranchStock(f.config.restaurantsPool,sample.actor,{
   storeId:sample.storeId,branchId:sample.branchId,variantId:v.id,
   operationId:id(),delta:1,reason:'restock'});
  const ordered=[
   {variantId:sample.variantId,quantity:1,expectedVersion:2,
    expectedPriceMinor:'3500',expectedName:'Jitomate saladet — 500 g'},
   {variantId:v.id,quantity:1,expectedVersion:2,
    expectedPriceMinor:'3000',expectedName:'Cebolla blanca — 1 kg'}
  ].sort((a,b)=>a.variantId.localeCompare(b.variantId));
  // Force failure on the SECOND physically locked variant, so the first
  // row has already been debited and MUST be restored by transaction rollback.
  ordered[1]!.expectedPriceMinor='9999';
  const holdId=id();
  await assert.rejects(reserveM6BranchStock(f.config.restaurantsPool,{
   holdId,storeId:sample.storeId,branchId:sample.branchId,
   lines:ordered
  }),isError('M11_HOLD_PRICE_DRIFT'));
  assert.deepEqual(await physical(f.config,sample),{m6:2,m1:2});
  const other=await f.config.restaurantsPool.query<{quantity:number}>(
   'SELECT quantity FROM tala_restaurants_v2.branch_stock '+
   'WHERE branch_id=$1::uuid AND variant_id=$2::uuid',
   [sample.branchId,v.id]);
  assert.equal(other.rows[0]?.quantity,1);
  assert.equal(await inspectM6StockHold(f.config.restaurantsPool,holdId),null);
  const rows=await f.config.restaurantsPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_restaurants_v2.order_stock_hold_events '+
   'WHERE hold_id=$1::uuid',[holdId]);
  assert.equal(rows.rows[0]?.n,0);
 }finally{await f.close();}
});

async function merchantM1(c:CatalogLabConfig,store:Setup){
 const actor=id(),email='lab7-merchant.'+id()+'@example.test';
 await c.ordersPool.query(
  'INSERT INTO tala_core_v2.accounts(id,email,display_name,password_hash,role) '+
  "VALUES($1::uuid,$2,'M11 staff lab',$3,'merchant')",
  [actor,email,await hashPassword(password)]);
 await c.ordersPool.query(
  'INSERT INTO tala_core_v2.restaurant_memberships '+
  '(restaurant_id,member_id,is_active) VALUES($1::uuid,$2::uuid,true)',
  [store.restaurantId,actor]);
 return {id:actor,sessionToken:await issueSession(c.ordersPool,actor)};
}
test('LAB7 M4+M6+M1 pickup -> M11 real outbox -> M5 inbox + M10 completion + M3 held, never payouts',
 {skip:!enabled,timeout:150000},async()=>{
 const f=fixture();
 const notificationPool=new pg.Pool({
  connectionString:process.env.NOTIFICATIONS_CI_URL??'',max:12});
 const analyticsPool=new pg.Pool({
  connectionString:process.env.ANALYTICS_CI_URL??'',max:12});
 const financePool=new pg.Pool({
  connectionString:process.env.FINANCE_CI_URL??'',max:12});
 try{
  const s=await setup(f.config,3),buyer=await customer(f.config),
   operator=await merchantM1(f.config,s);
  const order=await createReservedLabPickup(f.config,{
   sessionToken:buyer.sessionToken,cart:s.cart,
   idempotencyKey:'lab7-real-pickup-'+id()
  });
  const view=await f.config.ordersPool.query<{status:string}>(
   'SELECT status FROM tala_core_v2.orders WHERE id=$1::uuid',[order.orderId]);
  assert.equal(view.rows[0]?.status,'received');
  await assert.rejects(relayVerifiedM1PickupOutbox(f.config,{
   authenticated:false,canRelayM1Outbox:true},order.orderId),
   isError('M11_OUTBOX_RELAY_FORBIDDEN'));
  assert.equal((await relayVerifiedM1PickupOutbox(f.config,{
   authenticated:true,canRelayM1Outbox:true
  },order.orderId)).receipts.length,0,'order created is unpaid and never emitted');

  await setRecipientPreference(notificationPool,{
   recipientId:buyer.m4Id,app:'customer',category:'transactional',
   channel:'email',enabled:false});
  await setRecipientPreference(notificationPool,{
   recipientId:buyer.m4Id,app:'customer',category:'transactional',
   channel:'push',enabled:false});
  let expected='1';
  for(const target of ['confirmed','preparing','ready'] as const){
   const next=await advanceLabPickupMerchant(f.config,{
    merchantM1SessionToken:operator.sessionToken,orderId:order.orderId,
    target,commandKey:'lab7-progress-'+id(),expectedVersion:expected
   });
   assert.equal(next.status,target);
   expected=next.version;
  }
  assert.equal(expected,'4');
  const ready=await relayVerifiedM1PickupOutbox(f.config,{
   authenticated:true,canRelayM1Outbox:true},order.orderId);
  assert.equal(ready.receipts.length,1);
  assert.equal(ready.receipts[0]?.duplicate,false);
  const readyEvent=(await verifiedM1PickupEvents(f.config,order.orderId))
   .find(e=>e.kind==='orders.pickup_ready');
  assert.ok(readyEvent);
  const consumer=createM5NotificationLabConsumer({
   bridgePool:f.config.integrationPool,notificationPool,
   resolveTrustedRecipient:createRealM1PickupRecipientResolver(f.config)
  });
  const read1=await deliverOnce(f.config.integrationPool,'notifications',
   consumer,readyEvent.eventId);
  assert.equal('delivered' in read1&&read1.delivered,true);
  const firstInbox=await readInbox(notificationPool,{
   recipientId:buyer.m4Id,app:'customer'});
  assert.deepEqual(firstInbox.items.map(x=>x.eventType),['order.ready']);
  // Finance cannot post on an unfinished, unpaid cash order.
  await assert.rejects(recordRealM1PickupHeldFinance({
   pickup:f.config,financePool
  },{authenticated:true,canRecordHeldFinance:true},order.orderId),
   isError('M11_CASH_HANDOFF_NOT_PROVEN'));

  const pin=await issueLabPickupPin(f.config,{
   m4SessionToken:buyer.sessionToken,orderId:order.orderId});
  assert.match(pin.pin,/^\d{8}$/);
  const ackBuyer=await attestLabPickupBuyerCash(f.config,{
   m4SessionToken:buyer.sessionToken,orderId:order.orderId});
  assert.equal(ackBuyer.role,'customer');
  await assert.rejects(finishLabPickup(f.config,{
   merchantM1SessionToken:operator.sessionToken,orderId:order.orderId,
   commandKey:'lab7-finish-early-'+id(),expectedVersion:expected,pin:pin.pin
  }),e=>(e as {code?:string}).code==='CASH_DUAL_ACK_REQUIRED');
  const ackMerchant=await attestLabPickupMerchantCash(f.config,{
   merchantM1SessionToken:operator.sessionToken,orderId:order.orderId});
  assert.equal(ackMerchant.role,'merchant');
  const finishKey='lab7-finish-'+id();
  const done=await finishLabPickup(f.config,{
   merchantM1SessionToken:operator.sessionToken,orderId:order.orderId,
   commandKey:finishKey,expectedVersion:expected,pin:pin.pin});
  assert.equal(done.status,'delivered');
  assert.equal(done.paymentStatus,'paid_cash_in_custody');
  assert.equal(done.custodySettled,false);
  const again=await finishLabPickup(f.config,{
   merchantM1SessionToken:operator.sessionToken,orderId:order.orderId,
   commandKey:finishKey,expectedVersion:expected,pin:pin.pin});
  assert.equal('replayed' in again&&again.replayed,true);

  const emitted=await relayVerifiedM1PickupOutbox(f.config,{
   authenticated:true,canRelayM1Outbox:true},order.orderId);
  assert.equal(emitted.receipts.length,2);
  assert.equal(emitted.receipts.filter(x=>x.duplicate===false).length,1);
  const pickup=(await verifiedM1PickupEvents(f.config,order.orderId))
   .find(e=>e.kind==='orders.pickup_completed');
  assert.ok(pickup);
  const notification=await deliverOnce(f.config.integrationPool,'notifications',
   consumer,pickup.eventId);
  assert.equal('delivered' in notification&&notification.delivered,true);
  const inbox=await readInbox(notificationPool,{
   recipientId:buyer.m4Id,app:'customer'});
  assert.deepEqual(inbox.items.map(x=>x.eventType).sort(),
   ['order.delivered','order.ready']);
  const another=await readInbox(notificationPool,{
   recipientId:id(),app:'customer'});
  assert.equal(another.items.length,0);
  const keys:IssuerKeys={
   orders:{sample01:randomBytes(32)},
   payments:{sample01:randomBytes(32)},
   logistics:{sample01:randomBytes(32)}
  };
  const analytics=createM1PickupAnalyticsLabConsumer({
   pickup:f.config,analyticsPool,keys,kid:'sample01'});
  const metric=await deliverOnce(f.config.integrationPool,'analytics',
   analytics,pickup.eventId);
  assert.equal('delivered' in metric&&metric.delivered,true);
  const day=pickup.occurredAt.slice(0,10);
  const report=await merchantAnalytics(analyticsPool,{
   actorId:id(),authenticated:true,merchantId:s.restaurantId,
   canReadMerchantAnalytics:true
  },s.restaurantId,day,day);
  assert.equal(report.totals.ordersCompleted,'1');
  assert.equal(report.totals.deliveriesCompleted,'0');
  assert.equal(report.totals.paymentsConfirmed,'0');
  assert.equal(report.totals.orderGmvCents,order.totalMinor);

  await assert.rejects(recordRealM1PickupHeldFinance({
   pickup:f.config,financePool
  },{authenticated:false,canRecordHeldFinance:true},order.orderId),
   isError('M11_FINANCE_FORBIDDEN'));
  const posted=await recordRealM1PickupHeldFinance({
   pickup:f.config,financePool
  },{authenticated:true,canRecordHeldFinance:true},order.orderId);
  assert.equal(posted.replayed,false);
  assert.equal(posted.availableMinor,'0');
  assert.equal(posted.withdrawable,false);
  assert.equal(posted.cashCustodySettled,false);
  assert.equal(posted.policyApproved,false);
  const postedAgain=await recordRealM1PickupHeldFinance({
   pickup:f.config,financePool
  },{authenticated:true,canRecordHeldFinance:true},order.orderId);
  assert.equal(postedAgain.replayed,true);
  assert.equal(postedAgain.journalId,posted.journalId);
  const sums=await financePool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_finance_v2.journals '+
   'WHERE order_id=$1::uuid',[order.orderId]);
  assert.equal(sums.rows[0]?.n,1);
  assert.deepEqual(await physical(f.config,s),{m6:2,m1:2});
 }finally{
  await Promise.all([f.close(),notificationPool.end(),
   analyticsPool.end(),financePool.end()]);
 }
});

test('LAB7 customer/merchant cross-tenant authorization and uncommitted pickup outbox are denied',
 {skip:!enabled,timeout:120000},async()=>{
 const f=fixture();
 try{
  const s=await setup(f.config,2),owner=await customer(f.config);
  const foreign=await customer(f.config),operator=await merchantM1(f.config,s);
  const made=await createReservedLabPickup(f.config,{
   sessionToken:owner.sessionToken,cart:s.cart,
   idempotencyKey:'lab7-authorization-'+id()});
  await assert.rejects(issueLabPickupPin(f.config,{
   m4SessionToken:foreign.sessionToken,orderId:made.orderId
  }),isError('M11_BUYER_NOT_AUTHORIZED'));
  await assert.rejects(advanceLabPickupMerchant(f.config,{
   merchantM1SessionToken:'not-a-valid-session',
   orderId:made.orderId,target:'confirmed',
   expectedVersion:'1',commandKey:'lab7-invalid-'+id()
  }),isError('M11_MERCHANT_SESSION_REQUIRED'));
  const original=await relayVerifiedM1PickupOutbox(f.config,{
   authenticated:true,canRelayM1Outbox:true},made.orderId);
  assert.equal(original.receipts.length,0);
  await f.config.ordersPool.query(
   'UPDATE tala_core_v2.restaurant_memberships SET is_active=false '+
   'WHERE member_id=$1::uuid AND restaurant_id=$2::uuid',
   [operator.id,s.restaurantId]);
  await assert.rejects(advanceLabPickupMerchant(f.config,{
   merchantM1SessionToken:operator.sessionToken,
   orderId:made.orderId,target:'confirmed',
   expectedVersion:'1',commandKey:'lab7-revoked-'+id()
  }),isError('M11_MERCHANT_NOT_AUTHORIZED'));
 }finally{await f.close();}
});

function offlineStripeTest(){
 const pi='pi_'+randomBytes(14).toString('hex');
 let creates=0,gets=0,owner='',value=0;
 const client=new StripeTestClient({
  apiKey:'sk_test_M11_OFFLINE_FIXTURE_2026_NO_LIVE',
  transport:async(endpoint,init)=>{
   const path=String(endpoint),method=String(init?.method);
   if(path.endsWith('/v1/payment_intents')&&method==='POST'){
    creates++;
    const args=new URLSearchParams(String(init?.body??''));
    owner=String(args.get('metadata[m8_payment_id]'));
    value=Number(args.get('amount'));
   }else if(path.includes('/v1/payment_intents/')&&method==='GET'){
    gets++;
   }else{return new Response('{}',{status:404});}
   return new Response(JSON.stringify({
    id:pi,object:'payment_intent',livemode:false,
    amount:value,currency:'mxn',
    metadata:{m8_payment_id:owner},
    status:gets>0?'succeeded':'requires_payment_method',
    client_secret:pi+'_secret_TEST_ONLY'
   }),{status:200});
  }
 });
 return {client,pi,stats:()=>({creates,gets}),amount:()=>value};
}
function signedTestStripeWebhook(paymentId:string,pi:string,money:number,
 opts:{livemode?:boolean,amountOverride?:number}={}){
 const secret='whsec_M11_OFFLINE_TEST_WEBHOOK_2026_NOT_LIVE';
 const event={id:'evt_'+randomBytes(13).toString('hex'),
  type:'payment_intent.succeeded',livemode:opts.livemode??false,
  data:{object:{id:pi,object:'payment_intent',
   livemode:opts.livemode??false,amount:opts.amountOverride??money,
   amount_received:opts.amountOverride??money,currency:'mxn',
   status:'succeeded',metadata:{m8_payment_id:paymentId}}}};
 const raw=Buffer.from(JSON.stringify(event)),
  ts=String(Math.floor(Date.now()/1000));
 const signature='t='+ts+',v1='+createHmac('sha256',secret)
  .update(ts).update('.').update(raw).digest('hex');
 return {raw,signature,secret};
}
test('LAB8 M6 hold -> real M1 awaiting_payment -> M8 Stripe TEST intent -> signed webhook -> M1 received',
 {skip:!enabled,timeout:150000},async()=>{
 const f=fixture();
 const paymentsPool=new pg.Pool({
  connectionString:process.env.PAYMENTS_CI_URL??'',max:12});
 try{
  const s=await setup(f.config,3),buyer=await customer(f.config),
   gateway=offlineStripeTest();
  const config={...f.config,paymentsPool},key='lab8-stripe-'+id();
  const first=await startStripeTestLabPickup(config,gateway.client,{
   m4SessionToken:buyer.sessionToken,cart:s.cart,idempotencyKey:key});
  assert.equal(first.orderStatus,'awaiting_payment');
  assert.equal(first.provider,'stripe_test');
  assert.equal(first.testOnly,true);
  assert.equal(first.commercialReady,false);
  assert.equal(first.m6HoldConfirmed,false);
  assert.equal(first.clientSecret,gateway.pi+'_secret_TEST_ONLY');
  assert.equal(gateway.stats().creates,1);
  assert.deepEqual(await physical(f.config,s),{m6:2,m1:2});
  const awaiting=await f.config.ordersPool.query<{
   status:string,payment_status:string,payment_method:string}>(
   'SELECT status,payment_status,payment_method FROM tala_core_v2.orders '+
   'WHERE id=$1::uuid',[first.orderId]);
  assert.deepEqual(awaiting.rows[0],{
   status:'awaiting_payment',payment_status:'pending',payment_method:'stripe'});
  const absent=await reconcileStripeTestLabPickup(config,{
   authenticated:true,canReconcileStripeTest:true},first.intentId);
  assert.equal(absent.status,'awaiting_verified_test_webhook');
  await assert.rejects(reconcileStripeTestLabPickup(config,{
   authenticated:false,canReconcileStripeTest:true},first.intentId),
   isError('M11_STRIPE_RECONCILIATION_FORBIDDEN'));
  const invalid=signedTestStripeWebhook(first.paymentId,gateway.pi,
   gateway.amount(),{amountOverride:gateway.amount()+1});
  await assert.rejects(ingestStripeTestWebhook(paymentsPool,invalid.secret,
   invalid.raw,invalid.signature),e=>
    (e as {code?:string}).code==='M8_STRIPE_AMOUNT_MISMATCH');
  const live=signedTestStripeWebhook(first.paymentId,gateway.pi,
   gateway.amount(),{livemode:true});
  await assert.rejects(ingestStripeTestWebhook(paymentsPool,live.secret,
   live.raw,live.signature),e=>
    (e as {code?:string}).code==='M8_STRIPE_LIVEMODE_FORBIDDEN');
  const signed=signedTestStripeWebhook(first.paymentId,gateway.pi,
   gateway.amount());
  await assert.rejects(ingestStripeTestWebhook(paymentsPool,signed.secret,
   signed.raw,signed.signature.replace(/.$/,'0')),e=>
    (e as {code?:string}).code==='M8_STRIPE_SIGNATURE_INVALID');
  assert.equal((await ingestStripeTestWebhook(paymentsPool,signed.secret,
   signed.raw,signed.signature)).applied,true);
  assert.equal('replayed' in (await ingestStripeTestWebhook(paymentsPool,signed.secret,
   signed.raw,signed.signature)),true);
  const result=await reconcileStripeTestLabPickup(config,{
   authenticated:true,canReconcileStripeTest:true},first.intentId);
  assert.equal(result.status,'received');
  assert.equal(result.verified,true);
  assert.equal(result.commercialReady,false);
  assert.deepEqual(await physical(f.config,s),{m6:2,m1:2});
  assert.equal((await inspectM6StockHold(f.config.restaurantsPool,
   first.intentId))?.state,'confirmed');
  const again=await reconcileStripeTestLabPickup(config,{
   authenticated:true,canReconcileStripeTest:true},first.intentId);
  assert.equal(again.replayed,true);
  const row=await f.config.ordersPool.query<{status:string,payment_status:string,
   total_minor:string,version:string}>(
   'SELECT status,payment_status,total_minor::text,version::text '+
   'FROM tala_core_v2.orders WHERE id=$1::uuid',[first.orderId]);
  assert.equal(row.rows[0]?.status,'received');
  assert.equal(row.rows[0]?.payment_status,'paid');
  assert.equal(row.rows[0]?.total_minor,String(gateway.amount()));
  assert.equal(row.rows[0]?.version,'2');
  const audit=await f.config.ordersPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_core_v2.outbox '+
   "WHERE aggregate_id=$1::uuid AND event_type='order.payment.verified.test'",
   [first.orderId]);
  assert.equal(audit.rows[0]?.n,1);
  const paymentFacts=await paymentsPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_payments_v2.stripe_test_facts '+
   'WHERE payment_id=$1::uuid',[first.paymentId]);
  assert.equal(paymentFacts.rows[0]?.n,1);
  const retried=await startStripeTestLabPickup(config,gateway.client,{
   m4SessionToken:buyer.sessionToken,cart:s.cart,idempotencyKey:key});
  assert.equal(retried.orderId,first.orderId);
  assert.equal(retried.paymentId,first.paymentId);
  assert.equal(gateway.stats().creates,1);
  const count=await f.config.ordersPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_core_v2.orders '+
   'WHERE buyer_id=$1::uuid',[buyer.buyerId]);
  assert.equal(count.rows[0]?.n,1);
 }finally{await Promise.all([f.close(),paymentsPool.end()]);}
});
test('LAB8 M8 remains unverified without a signed webhook and keeps M6 physical hold',
 {skip:!enabled,timeout:120000},async()=>{
 const f=fixture();
 const paymentsPool=new pg.Pool({
  connectionString:process.env.PAYMENTS_CI_URL??'',max:10});
 try{
  const s=await setup(f.config,1),u=await customer(f.config),
   provider=offlineStripeTest(),config={...f.config,paymentsPool},
   key='lab8-pending-'+id();
  const pending=await startStripeTestLabPickup(config,provider.client,{
   m4SessionToken:u.sessionToken,cart:s.cart,idempotencyKey:key});
  const r=await reconcileStripeTestLabPickup(config,{
   authenticated:true,canReconcileStripeTest:true},pending.intentId);
  assert.equal('paymentConfirmed' in r&&r.paymentConfirmed,false);
  assert.equal(r.status,'awaiting_verified_test_webhook');
  assert.deepEqual(await physical(f.config,s),{m6:0,m1:0});
  const hold=await inspectM6StockHold(f.config.restaurantsPool,pending.intentId);
  assert.equal(hold?.state,'reserved');
  assert.equal((await f.config.ordersPool.query<{status:string}>(
   'SELECT status FROM tala_core_v2.orders WHERE id=$1::uuid',
   [pending.orderId])).rows[0]?.status,'awaiting_payment');
  await assert.rejects(startStripeTestLabPickup(config,provider.client,{
   m4SessionToken:u.sessionToken,
   cart:{...s.cart,lines:[{...s.cart.lines[0]!,quantity:2}]},
   idempotencyKey:key}),isError('M11_STRIPE_IDEMPOTENCY_CONFLICT'));
 }finally{await Promise.all([f.close(),paymentsPool.end()]);}
});
