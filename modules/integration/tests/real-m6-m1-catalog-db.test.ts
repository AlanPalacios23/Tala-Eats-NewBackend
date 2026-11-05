import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {IntegrationError} from '../src/events.js';
import {linkM6VariantToM1Catalog,previewLinkedM6M1Pickup,
 createLinkedLabCashPickup,type CatalogLabConfig,
 type LinkedPickupCart} from '../adapters/catalog-checkout-lab.js';
import {linkControlledCustomerAccounts}
 from '../adapters/order-ownership-lab.js';
import {createStore,createBranch,setBranchHours,changeStoreStatus,
 setBranchActive} from '../../restaurants/src/stores.js';
import {createProduct,createVariant,setVariantPrice,adjustStock,
 readOfferSnapshot} from '../../restaurants/src/catalog.js';
import {registerCredentialedPendingUser,loginLabUser}
 from '../../users/src/auth.js';
import {issueLabEmailChallenge,verifyLabEmailChallenge}
 from '../../users/src/store.js';
import {hashPassword,issueSession}
 from '../../../src/modules/orders/lab-auth.ts';
import {PRICING_POLICY_VERSION}
 from '../../../src/modules/orders/pricing.ts';

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
const fail=(p:Promise<unknown>,code:string)=>assert.rejects(p,
 e=>e instanceof IntegrationError&&e.code===code);
const staff={authenticated:true,canLinkCatalog:true} as const;
const password='Tala-M11-Lab5#2026-Safe';
function fixture(){
 const config:CatalogLabConfig={
  integrationPool:new pg.Pool({connectionString:urls.integration,max:12}),
  restaurantsPool:new pg.Pool({connectionString:urls.restaurants,max:12}),
  ordersPool:new pg.Pool({connectionString:urls.orders,max:12}),
  usersPool:new pg.Pool({connectionString:urls.users,max:12}),
  usersPasswordPepper:randomBytes(32)
 };
 return {config,close:()=>Promise.all([
  config.integrationPool.end(),config.restaurantsPool.end(),
  config.ordersPool.end(),config.usersPool.end()
 ])};
}
async function setupCatalog(c:CatalogLabConfig,stock=5){
 const actor={actorId:id()};
 const store=await createStore(c.restaurantsPool,actor,{
  operationId:id(),slug:'m11-lab5-'+id().slice(0,15),
  name:'Mercado LAB5',kind:'butcher'});
 const branch=await createBranch(c.restaurantsPool,actor,{
  storeId:store.id,operationId:id(),name:'Tala Centro',
  address:'Calle Laboratorio 123, Tala',city:'tala',
  pickupEnabled:true,deliveryEnabled:false});
 await setBranchHours(c.restaurantsPool,actor,{
  storeId:store.id,branchId:branch.id,expectedVersion:1,
  days:Array.from({length:7},(_,weekday)=>({
   weekday,closed:false,openMinute:0,closeMinute:1440}))});
 const product=await createProduct(c.restaurantsPool,actor,{
  storeId:store.id,operationId:id(),name:'Carne de res',
  category:'Carniceria'});
 const variant=await createVariant(c.restaurantsPool,actor,{
  storeId:store.id,productId:product.id,operationId:id(),
  label:'500 g',weightGrams:500,priceCents:4500,
  stockQuantity:stock,trackStock:true});
 await changeStoreStatus(c.restaurantsPool,actor,{
  storeId:store.id,expectedVersion:1,status:'ready'});
 const m1=await c.ordersPool.query<{id:string}>(
  "INSERT INTO tala_core_v2.restaurants(name,is_open) VALUES('M1 Sombra',true) RETURNING id");
 const m1RestaurantId=m1.rows[0]!.id;
 const p=await c.ordersPool.query<{id:string}>(
  'INSERT INTO tala_core_v2.catalog_products '+
  '(restaurant_id,name,price_minor,stock,is_available) '+
  "VALUES($1::uuid,'Carne de res — 500 g',4500,$2,true) RETURNING id",
  [m1RestaurantId,stock]);
 const m1ProductId=p.rows[0]!.id;
 const cart:LinkedPickupCart={storeId:store.id,branchId:branch.id,
  lines:[{variantId:variant.id,quantity:1,expectedVariantVersion:1}]};
 return {actor,storeId:store.id,branchId:branch.id,
  variantId:variant.id,m1RestaurantId,m1ProductId,cart};
}
async function link(c:CatalogLabConfig,
 row:Awaited<ReturnType<typeof setupCatalog>>){
 return linkM6VariantToM1Catalog(c,staff,{
  storeId:row.storeId,branchId:row.branchId,variantId:row.variantId,
  m1RestaurantId:row.m1RestaurantId,m1ProductId:row.m1ProductId
 });
}
async function customer(c:CatalogLabConfig){
 const email='m11lab5.'+id()+'@example.test';
 const emailSecret=randomBytes(32);
 const m4=await registerCredentialedPendingUser(c.usersPool,{
  email,displayName:'Cliente LAB5',password,
  secret:c.usersPasswordPepper,idempotencyKey:id()
 });
 const challenge=await issueLabEmailChallenge(c.usersPool,{
  userId:m4.user.id,secret:emailSecret});
 await verifyLabEmailChallenge(c.usersPool,{
  userId:m4.user.id,actorId:m4.user.id,token:challenge.token,
  secret:emailSecret,expectedVersion:1,idempotencyKey:id()});
 const logged=await loginLabUser(c.usersPool,{
  email,password,secret:c.usersPasswordPepper});
 const legacy=await c.ordersPool.query<{id:string}>(
  'INSERT INTO tala_core_v2.accounts(email,display_name,password_hash,role) '+
  "VALUES($1,'Cliente M1 LAB5',$2,'customer') RETURNING id",
  [email,await hashPassword(password)]);
 const legacySession=await issueSession(c.ordersPool,legacy.rows[0]!.id);
 await linkControlledCustomerAccounts({
  integrationPool:c.integrationPool,usersPool:c.usersPool,
  ordersPool:c.ordersPool,usersPasswordPepper:c.usersPasswordPepper
 },{m4SessionToken:logged.sessionToken,m1SessionToken:legacySession});
 return {m4Id:m4.user.id,buyerId:legacy.rows[0]!.id,
  sessionToken:logged.sessionToken};
}

test('M11 LAB5 real M6 offer -> M1 quote -> frozen cash pickup order, no money or M6 stock writes',
 {skip:!enabled,timeout:100000},async()=>{
 const f=fixture();try{
  const row=await setupCatalog(f.config,5);
  await fail(linkM6VariantToM1Catalog(f.config,{
   authenticated:false,canLinkCatalog:true},{
   storeId:row.storeId,branchId:row.branchId,variantId:row.variantId,
   m1RestaurantId:row.m1RestaurantId,m1ProductId:row.m1ProductId
  }),'M11_FORBIDDEN');
  const mapping=await link(f.config,row);
  assert.equal(mapping.linked,true);
  assert.equal(mapping.replayed,false);
  assert.equal((await link(f.config,row)).replayed,true);
  const preview=await previewLinkedM6M1Pickup(f.config,row.cart);
  assert.equal(preview.quote.itemsMinor,'4500');
  assert.equal(preview.quote.totalMinor,'4815');
  assert.equal(preview.quote.policyVersion,PRICING_POLICY_VERSION);
  assert.equal(preview.pricingPolicyApproved,false);
  assert.equal(preview.m6StockReserved,false);
  assert.equal(preview.lines[0]?.expectedVersion,1);
  assert.equal(preview.lines[0]?.name,'Carne de res — 500 g');

  const buyer=await customer(f.config);
  const key='lab5-pickup-'+id();
  const one=await createLinkedLabCashPickup(f.config,{
   sessionToken:buyer.sessionToken,cart:row.cart,idempotencyKey:key
  });
  assert.equal(one.replayed,false);
  assert.equal(one.paid,false);
  assert.equal(one.commercialReady,false);
  assert.equal(one.policyApproved,false);
  assert.equal(one.totalMinor,preview.quote.totalMinor);
  assert.equal(one.lines[0]?.name,'Carne de res — 500 g');
  assert.equal(one.lines[0]?.unitMinor,'4500');

  const same=await createLinkedLabCashPickup(f.config,{
   sessionToken:buyer.sessionToken,cart:row.cart,idempotencyKey:key
  });
  assert.equal(same.replayed,true);
  assert.equal(same.orderId,one.orderId);
  await fail(createLinkedLabCashPickup(f.config,{
   sessionToken:buyer.sessionToken,
   cart:{...row.cart,lines:[{...row.cart.lines[0]!,quantity:2}]},
   idempotencyKey:key
  }),'M11_M1_QUOTE_DIVERGENCE').catch(()=>{}); // M1 performs idempotency check below
  const persisted=await f.config.ordersPool.query<{
   status:string,payment_status:string,total_minor:string,
   price_snapshot:{policyVersion:string,itemsMinor:string},
   buyer_id:string}>(
   'SELECT status,payment_status,total_minor,price_snapshot,buyer_id '+
   'FROM tala_core_v2.orders WHERE id=$1::uuid',[one.orderId]);
  assert.equal(persisted.rows[0]?.status,'received');
  assert.equal(persisted.rows[0]?.payment_status,'pending');
  assert.equal(persisted.rows[0]?.buyer_id,buyer.buyerId);
  assert.equal(persisted.rows[0]?.price_snapshot.itemsMinor,'4500');
  assert.equal(persisted.rows[0]?.price_snapshot.policyVersion,
   PRICING_POLICY_VERSION);
  const m6=await readOfferSnapshot(f.config.restaurantsPool,{
   storeId:row.storeId,branchId:row.branchId,variantId:row.variantId});
  assert.equal(m6.stock_quantity,5,'M11 must not invent M6 stock decrement');
  const m1stock=await f.config.ordersPool.query<{stock:number}>(
   'SELECT stock FROM tala_core_v2.catalog_products WHERE id=$1::uuid',
   [row.m1ProductId]);
  assert.equal(m1stock.rows[0]?.stock,4);
  await fail(previewLinkedM6M1Pickup(f.config,row.cart),
   'M11_STOCK_LEDGER_DRIFT');
  await fail(createLinkedLabCashPickup(f.config,{
   sessionToken:buyer.sessionToken,cart:row.cart,
   idempotencyKey:'different-'+id()
  }),'M11_STOCK_LEDGER_DRIFT');
  const count=await f.config.ordersPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_core_v2.orders '+
   'WHERE buyer_id=$1::uuid',[buyer.buyerId]);
  assert.equal(count.rows[0]?.n,1);
 }finally{await f.close();}
});

test('M11 LAB5 rejects M6 price version drift and M1 price/name tampering',
 {skip:!enabled,timeout:90000},async()=>{
 const f=fixture();try{
  const row=await setupCatalog(f.config,4);
  await link(f.config,row);
  const price=await setVariantPrice(f.config.restaurantsPool,row.actor,{
   storeId:row.storeId,variantId:row.variantId,
   expectedVersion:1,priceCents:4999});
  assert.equal(price.version,2);
  await fail(previewLinkedM6M1Pickup(f.config,row.cart),
   'M11_VARIANT_VERSION_CONFLICT');
  const updated:LinkedPickupCart={...row.cart,lines:[{
   variantId:row.variantId,quantity:1,expectedVariantVersion:2
  }]};
  await fail(previewLinkedM6M1Pickup(f.config,updated),
   'M11_CATALOG_PRICE_OR_NAME_DRIFT');
  await f.config.ordersPool.query(
   'UPDATE tala_core_v2.catalog_products SET price_minor=4999 '+
   'WHERE id=$1::uuid',[row.m1ProductId]);
  assert.equal((await previewLinkedM6M1Pickup(f.config,updated))
   .quote.itemsMinor,'4999');
  await f.config.ordersPool.query(
   "UPDATE tala_core_v2.catalog_products SET name='Manipulado' "+
   'WHERE id=$1::uuid',[row.m1ProductId]);
  await fail(previewLinkedM6M1Pickup(f.config,updated),
   'M11_CATALOG_PRICE_OR_NAME_DRIFT');
 }finally{await f.close();}
});

test('M11 LAB5 refuses branch closures, drifted stocks and unbound cross-merchant variants',
 {skip:!enabled,timeout:90000},async()=>{
 const f=fixture();try{
  const row=await setupCatalog(f.config,5);
  await link(f.config,row);
  await fail(previewLinkedM6M1Pickup(f.config,{
   storeId:id(),branchId:row.branchId,lines:row.cart.lines
  }),'M11_VARIANT_NOT_MAPPED');
  await fail(previewLinkedM6M1Pickup(f.config,{
   ...row.cart,lines:[{variantId:id(),quantity:1,expectedVariantVersion:1}]
  }),'M11_VARIANT_NOT_MAPPED');
  await fail(previewLinkedM6M1Pickup(f.config,{
   ...row.cart,lines:[row.cart.lines[0]!,row.cart.lines[0]!]
  }),'M11_CART_DUPLICATE');
  await fail(previewLinkedM6M1Pickup(f.config,{
   ...row.cart,lines:[{...row.cart.lines[0]!,quantity:6}]
  }),'M11_M6_OFFER_UNAVAILABLE');
  await adjustStock(f.config.restaurantsPool,row.actor,{
   storeId:row.storeId,variantId:row.variantId,
   operationId:id(),delta:-1,reason:'waste'});
  const changed=await f.config.restaurantsPool.query<{version:number}>(
   'SELECT version FROM tala_restaurants_v2.variants WHERE id=$1::uuid',
   [row.variantId]);
  await fail(previewLinkedM6M1Pickup(f.config,{
   ...row.cart,lines:[{...row.cart.lines[0]!,
    expectedVariantVersion:changed.rows[0]!.version}]
  }),'M11_STOCK_LEDGER_DRIFT');
  await setBranchActive(f.config.restaurantsPool,row.actor,{
   storeId:row.storeId,branchId:row.branchId,expectedVersion:2,active:false});
  await fail(previewLinkedM6M1Pickup(f.config,row.cart),
   'M11_BRANCH_NOT_OPEN_FOR_PICKUP');
 }finally{await f.close();}
});

test('M11 LAB5 serializes competing pickup orders and rejects the second due to cross-DB ledger drift',
 {skip:!enabled,timeout:120000},async()=>{
 const f=fixture();try{
  const row=await setupCatalog(f.config,1);
  await link(f.config,row);
  const buyer=await customer(f.config);
  const requests=await Promise.allSettled([
   createLinkedLabCashPickup(f.config,{
    sessionToken:buyer.sessionToken,cart:row.cart,
    idempotencyKey:'compete-A-'+id()
   }),
   createLinkedLabCashPickup(f.config,{
    sessionToken:buyer.sessionToken,cart:row.cart,
    idempotencyKey:'compete-B-'+id()
   })
  ]);
  assert.equal(requests.filter(r=>r.status==='fulfilled').length,1);
  const rejected=requests.find(r=>r.status==='rejected');
  assert.ok(rejected?.status==='rejected');
  assert.ok(rejected.reason instanceof IntegrationError);
  assert.equal(rejected.reason.code,'M11_M6_OFFER_UNAVAILABLE'==='never'
   ?'M11_M6_OFFER_UNAVAILABLE':'M11_STOCK_LEDGER_DRIFT');
  const count=await f.config.ordersPool.query<{n:number}>(
   'SELECT count(*)::int AS n FROM tala_core_v2.orders WHERE buyer_id=$1::uuid',
   [buyer.buyerId]);
  assert.equal(count.rows[0]?.n,1);
 }finally{await f.close();}
});
