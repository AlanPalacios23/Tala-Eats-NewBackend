/** M11 LAB5: actual M6 offer -> M1 pickup quote and cash-order bridge.
 * BOTH databases have independent stock. A strict equality gate makes
 * checkout fail CLOSED when the ledgers drift. M1 stock is decremented on
 * LAB checkout, M6 is deliberately NOT decremented. Commercial NO-GO.
 * Never publish as a customer checkout route.
 */
import type {Pool,PoolClient} from 'pg';
import {readOfferSnapshot} from '../../restaurants/src/catalog.js';
import {getBranchAvailability} from '../../restaurants/src/stores.js';
import {readAuthenticatedProfile,readMyIdentityRole}
 from '../../users/src/auth.js';
import {createCashOrder,previewCart,type CreateInput}
 from '../../../src/modules/orders/checkout.ts';
import {IntegrationError,validUuid} from '../src/events.js';

export type CatalogLabConfig={
 integrationPool:Pool,restaurantsPool:Pool,ordersPool:Pool,
 usersPool:Pool,usersPasswordPepper:Buffer
};
export type CatalogHost={authenticated:true,canLinkCatalog:true};
export type LinkedCartLine={
 variantId:string,quantity:number,expectedVariantVersion:number
};
export type LinkedPickupCart={
 storeId:string,branchId:string,lines:LinkedCartLine[]
};
type CatalogMapping={m6_variant_id:string,m1_product_id:string,
 m1_restaurant_id:string,m6_store_id:string,m6_branch_id:string};
type M1Product={id:string,name:string,price_minor:string,stock:number,
 is_available:boolean,is_open:boolean};
const allowedDatabases={
 integration:'tala_integration_v2_test',restaurants:'tala_restaurants_v2_test',
 orders:'tala_core_v2_test',users:'tala_users_v2_test'
} as const;

function noProduction(){
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
}
async function dbGate(pool:Pool,valid:string){
 noProduction();
 const r=await pool.query<{name:string}>('SELECT current_database() AS name');
 if(r.rows[0]?.name!==valid)
  throw new IntegrationError('M11_LAB_ONLY');
}
async function gated<T>(pool:Pool,fn:(c:PoolClient)=>Promise<T>,
 readOnly=false):Promise<T>{
 noProduction();
 const c=await pool.connect();
 try{
  await c.query(readOnly?'BEGIN READ ONLY':'BEGIN');
  await c.query("SET LOCAL statement_timeout='12000ms'");
  await c.query("SET LOCAL lock_timeout='3000ms'");
  const r=await c.query<{name:string}>('SELECT current_database() AS name');
  if(r.rows[0]?.name!==allowedDatabases.integration)
   throw new IntegrationError('M11_LAB_ONLY');
  const value=await fn(c);
  await c.query('COMMIT');return value;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;
 }finally{c.release();}
}
const safeInt=(v:unknown,min:number,max:number,code:string)=>{
 if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)
  throw new IntegrationError(code);
 return v;
};
function configGuard(config:CatalogLabConfig){
 if(!config?.ordersPool||!config?.restaurantsPool||
   !config?.integrationPool||!config?.usersPool||
   !Buffer.isBuffer(config.usersPasswordPepper)||
   config.usersPasswordPepper.length<32)
  throw new IntegrationError('M11_CATALOG_CONFIG_INVALID');
}
const checkoutKeys=['storeId','branchId','lines'];
function normalizedCart(input:LinkedPickupCart):LinkedPickupCart{
 if(!input||typeof input!=='object'||Array.isArray(input)||
  Object.keys(input).some(x=>!checkoutKeys.includes(x))||
  Object.keys(input).length!==checkoutKeys.length||
  !Array.isArray(input.lines)||input.lines.length<1||input.lines.length>50)
  throw new IntegrationError('M11_CART_INVALID');
 const storeId=validUuid(input.storeId),branchId=validUuid(input.branchId);
 const seen=new Set<string>();
 const lines=input.lines.map(l=>{
  if(!l||typeof l!=='object'||Array.isArray(l)||
   Object.keys(l).length!==3||
   !['variantId','quantity','expectedVariantVersion'].every(k=>Object.hasOwn(l,k)))
   throw new IntegrationError('M11_CART_INVALID');
  const variantId=validUuid(l.variantId);
  if(seen.has(variantId))throw new IntegrationError('M11_CART_DUPLICATE');
  seen.add(variantId);
  return {variantId,
   quantity:safeInt(l.quantity,1,100,'M11_CART_INVALID'),
   expectedVariantVersion:safeInt(l.expectedVariantVersion,1,2147483646,
    'M11_VARIANT_VERSION_INVALID')};
 });
 return {storeId,branchId,lines};
}
async function m1Product(pool:Pool,restaurantId:string,productId:string):
 Promise<M1Product>{
 const r=await pool.query<M1Product>(
  'SELECT p.id,p.name,p.price_minor::text AS price_minor,p.stock,'+
  'p.is_available,r.is_open FROM tala_core_v2.catalog_products p '+
  'JOIN tala_core_v2.restaurants r ON r.id=p.restaurant_id '+
  'WHERE r.id=$1::uuid AND p.id=$2::uuid',
  [restaurantId,productId]);
 if(!r.rows[0])throw new IntegrationError('M11_M1_PRODUCT_UNAVAILABLE');
 return r.rows[0];
}
async function checkedOffer(config:CatalogLabConfig,input:{
 storeId:string,branchId:string,variantId:string,m1RestaurantId:string,
 m1ProductId:string,quantity:number,expectedVariantVersion?:number
},at:Date){
 const availability=await getBranchAvailability(config.restaurantsPool,{
  storeId:input.storeId,branchId:input.branchId,at});
 if(!availability.pickupAvailable)
  throw new IntegrationError('M11_BRANCH_NOT_OPEN_FOR_PICKUP');
 const offer=await readOfferSnapshot(config.restaurantsPool,{
  storeId:input.storeId,branchId:input.branchId,
  variantId:input.variantId,at});
 if(offer.available!==true||offer.currency!=='MXN'||
   offer.track_stock!==true||!Number.isSafeInteger(offer.stock_quantity)||
   offer.stock_quantity<input.quantity)
  throw new IntegrationError('M11_M6_OFFER_UNAVAILABLE');
 if(input.expectedVariantVersion!==undefined&&
    offer.variant_version!==input.expectedVariantVersion)
  throw new IntegrationError('M11_VARIANT_VERSION_CONFLICT');
 const actual=await m1Product(config.ordersPool,input.m1RestaurantId,
  input.m1ProductId);
 if(!actual.is_open||!actual.is_available)
  throw new IntegrationError('M11_M1_PRODUCT_UNAVAILABLE');
 // M1's intentionally separate catalog must exactly reflect M6's
 // FULL variant description. An unpriced/renamed/badly mapped product
 // is not silently substituted.
 const expectedName=offer.product_name+' — '+offer.variant_label;
 if(actual.name!==expectedName||actual.price_minor!==offer.price_cents)
  throw new IntegrationError('M11_CATALOG_PRICE_OR_NAME_DRIFT');
 if(actual.stock!==offer.stock_quantity)
  throw new IntegrationError('M11_STOCK_LEDGER_DRIFT');
 if(actual.stock<input.quantity)
  throw new IntegrationError('M11_M1_STOCK_UNAVAILABLE');
 return Object.freeze({variantId:input.variantId,productId:input.m1ProductId,
  expectedVersion:offer.variant_version,name:expectedName,
  unitMinor:offer.price_cents,quantity:input.quantity,
  stockBefore:offer.stock_quantity});
}

/** Staff-only, isolated one-time mapping. No public endpoint. */
export async function linkM6VariantToM1Catalog(config:CatalogLabConfig,
 host:CatalogHost,input:{storeId:string,branchId:string,variantId:string,
 m1RestaurantId:string,m1ProductId:string}){
 noProduction();configGuard(config);
 if(host?.authenticated!==true||host.canLinkCatalog!==true)
  throw new IntegrationError('M11_FORBIDDEN');
 const storeId=validUuid(input.storeId),branchId=validUuid(input.branchId),
 variantId=validUuid(input.variantId),
 m1RestaurantId=validUuid(input.m1RestaurantId),
 m1ProductId=validUuid(input.m1ProductId);
 await Promise.all([
  dbGate(config.ordersPool,allowedDatabases.orders),
  dbGate(config.restaurantsPool,allowedDatabases.restaurants)]);
 const checked=await checkedOffer(config,{storeId,branchId,variantId,
  m1RestaurantId,m1ProductId,quantity:1},new Date());
 return gated(config.integrationPool,async c=>{
  try{
   await c.query('INSERT INTO tala_integration_v2.branch_catalog_links '+
    '(m6_store_id,m6_branch_id,m1_restaurant_id) '+
    'VALUES($1::uuid,$2::uuid,$3::uuid) '+
    'ON CONFLICT DO NOTHING',
    [storeId,branchId,m1RestaurantId]);
   const current=await c.query<{
    m6_store_id:string,m1_restaurant_id:string}>(
    'SELECT m6_store_id,m1_restaurant_id '+
    'FROM tala_integration_v2.branch_catalog_links '+
    'WHERE m6_branch_id=$1::uuid',[branchId]);
   if(current.rows[0]?.m6_store_id!==storeId||
      current.rows[0]?.m1_restaurant_id!==m1RestaurantId)
    throw new IntegrationError('M11_BRANCH_CATALOG_LINK_CONFLICT');
   const inserted=await c.query(
    'INSERT INTO tala_integration_v2.variant_catalog_links '+
    '(m6_store_id,m6_branch_id,m6_variant_id,m1_restaurant_id,m1_product_id) '+
    'VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid) '+
    'ON CONFLICT DO NOTHING RETURNING m6_variant_id',
    [storeId,branchId,variantId,m1RestaurantId,m1ProductId]);
   const mapped=await c.query<{m1_product_id:string,
    m6_store_id:string,m1_restaurant_id:string}>(
    'SELECT m1_product_id,m6_store_id,m1_restaurant_id '+
    'FROM tala_integration_v2.variant_catalog_links '+
    'WHERE m6_branch_id=$1::uuid AND m6_variant_id=$2::uuid',
    [branchId,variantId]);
   if(mapped.rows[0]?.m1_product_id!==m1ProductId||
      mapped.rows[0]?.m6_store_id!==storeId||
      mapped.rows[0]?.m1_restaurant_id!==m1RestaurantId)
    throw new IntegrationError('M11_VARIANT_CATALOG_LINK_CONFLICT');
   return Object.freeze({linked:true as const,
    replayed:inserted.rowCount===0,storeId,branchId,variantId,
    m1RestaurantId,m1ProductId,priceMinor:checked.unitMinor,
    m6StockUnreserved:true as const});
  }catch(e){
   if((e as {code?:string}).code==='23505')
    throw new IntegrationError('M11_VARIANT_CATALOG_LINK_CONFLICT');
   throw e;
  }
 });
}
async function mappedLines(config:CatalogLabConfig,cart:LinkedPickupCart,
 c:PoolClient){
 const ids=cart.lines.map(x=>x.variantId);
 const rows=await c.query<CatalogMapping>(
  'SELECT m6_store_id,m6_branch_id,m6_variant_id,'+
  'm1_restaurant_id,m1_product_id '+
  'FROM tala_integration_v2.variant_catalog_links '+
  'WHERE m6_store_id=$1::uuid AND m6_branch_id=$2::uuid '+
  'AND m6_variant_id=ANY($3::uuid[])',[cart.storeId,cart.branchId,ids]);
 if(rows.rows.length!==cart.lines.length)
  throw new IntegrationError('M11_VARIANT_NOT_MAPPED');
 const entries=new Map(rows.rows.map(x=>[x.m6_variant_id,x]));
 const restaurants=new Set(rows.rows.map(x=>x.m1_restaurant_id));
 if(restaurants.size!==1)
  throw new IntegrationError('M11_BRANCH_CATALOG_LINK_CONFLICT');
 const restaurantId=rows.rows[0]!.m1_restaurant_id;
 const lines=cart.lines.map(line=>{
  const mapped=entries.get(line.variantId);
  if(!mapped)throw new IntegrationError('M11_VARIANT_NOT_MAPPED');
  return {...line,m1RestaurantId:restaurantId,m1ProductId:mapped.m1_product_id};
 });
 return {restaurantId,lines};
}
async function previewInTransaction(config:CatalogLabConfig,
 cart:LinkedPickupCart,c:PoolClient){
 const mapped=await mappedLines(config,cart,c);
 // M6 prices and stock are read first; M1 independently validates its
 // own saved price/stock and calculates the ORIGINAL M1 pricing policy.
 const at=new Date();
 const verified=[];
 for(const line of mapped.lines){
  verified.push(await checkedOffer(config,{storeId:cart.storeId,
   branchId:cart.branchId,variantId:line.variantId,
   m1RestaurantId:line.m1RestaurantId,m1ProductId:line.m1ProductId,
   quantity:line.quantity,expectedVariantVersion:line.expectedVariantVersion},
   at));
 }
 const m1Cart={restaurantId:mapped.restaurantId,
  fulfillment:'pickup' as const,
  lines:verified.map(x=>({productId:x.productId,quantity:x.quantity}))};
 const quote=await previewCart(config.ordersPool,m1Cart);
 const amount=verified.reduce((n,line)=>
  n+BigInt(line.unitMinor)*BigInt(line.quantity),0n);
 if(quote.itemsMinor!==String(amount)||
  quote.lines.length!==verified.length||
  !quote.lines.every((x,i)=>{
   const mappedLine=verified[i]!;
   return x.productId===mappedLine.productId&&
    x.unitMinor===mappedLine.unitMinor&&
    x.name===mappedLine.name&&x.quantity===mappedLine.quantity;
  }))
  throw new IntegrationError('M11_M1_QUOTE_DIVERGENCE');
 return Object.freeze({m1Cart,quote,verified});
}
export async function previewLinkedM6M1Pickup(config:CatalogLabConfig,
 input:LinkedPickupCart){
 noProduction();configGuard(config);
 const cart=normalizedCart(input);
 await Promise.all([
  dbGate(config.ordersPool,allowedDatabases.orders),
  dbGate(config.restaurantsPool,allowedDatabases.restaurants)]);
 return gated(config.integrationPool,async c=>{
  const state=await previewInTransaction(config,cart,c);
  return Object.freeze({storeId:cart.storeId,branchId:cart.branchId,
   quote:state.quote,lines:state.verified,
   source:'real_m6_and_m1_read_contracts' as const,
   pricingPolicyApproved:false as const,commercialReady:false as const,
   m6StockReserved:false as const,paymentConfirmed:false as const});
 },true);
}
async function resolveLinkedBuyer(config:CatalogLabConfig,
 sessionToken:string,c:PoolClient){
 const user=await readAuthenticatedProfile(config.usersPool,{
  sessionToken,secret:config.usersPasswordPepper
 }).catch(()=>null);
 if(!user)throw new IntegrationError('M11_IDENTITY_NOT_AUTHENTICATED');
 const role=await readMyIdentityRole(config.usersPool,{
  sessionToken,secret:config.usersPasswordPepper
 }).catch(()=>null);
 if(role?.role!=='customer'||role.userId!==user.id)
  throw new IntegrationError('M11_CUSTOMER_ROLE_REQUIRED');
 const m4UserId=validUuid(user.id);
 const linked=await c.query<{m1_customer_id:string}>(
  'SELECT x.m1_customer_id FROM '+
  'tala_integration_v2.customer_identity_links x '+
  'WHERE x.m4_user_id=$1::uuid AND NOT EXISTS('+
  'SELECT 1 FROM tala_integration_v2.customer_link_revocations r '+
  'WHERE r.m4_user_id=x.m4_user_id)',[m4UserId]);
 const buyer=linked.rows[0]?.m1_customer_id;
 if(!buyer)throw new IntegrationError('M11_IDENTITY_LINK_REQUIRED');
 const active=await config.ordersPool.query<{ok:boolean}>(
  'SELECT EXISTS(SELECT 1 FROM tala_core_v2.accounts '+
  "WHERE id=$1::uuid AND is_active=true AND role='customer') AS ok",[buyer]);
 if(!active.rows[0]?.ok)
  throw new IntegrationError('M11_M1_CUSTOMER_INACTIVE');
 return buyer;
}
/** Exactly one safe LAB checkout through M1, no M6 inventory writes.
 * New requests serialize by branch, and detect divergence before any M1
 * stock decrement. Replays are delegated to M1's buyer-scoped idempotency
 * even when ledgers have drifted after the first checkout.
 */
export async function createLinkedLabCashPickup(config:CatalogLabConfig,
 input:{sessionToken:string,cart:LinkedPickupCart,idempotencyKey:string}){
 noProduction();configGuard(config);
 if(typeof input.idempotencyKey!=='string'||
  !/^[a-zA-Z0-9_.:-]{16,128}$/.test(input.idempotencyKey))
  throw new IntegrationError('M11_CHECKOUT_KEY_INVALID');
 const cart=normalizedCart(input.cart);
 await Promise.all([
  dbGate(config.ordersPool,allowedDatabases.orders),
  dbGate(config.restaurantsPool,allowedDatabases.restaurants)]);
 return gated(config.integrationPool,async c=>{
  // Serialize parallel new checkouts for the same branch on a shared
  // PostgreSQL advisory lock. M6 itself does NOT acquire this lock, so
  // cross-db stock/price changes remain an unresolved LIVE blocker.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,6001))',
   [cart.branchId]);
  const buyerId=await resolveLinkedBuyer(config,input.sessionToken,c);
  const mapped=await mappedLines(config,cart,c);
  const m1Input:CreateInput={restaurantId:mapped.restaurantId,
   fulfillment:'pickup',paymentMethod:'cash',
   lines:mapped.lines.map(x=>({productId:x.m1ProductId,quantity:x.quantity})),
   idempotencyKey:input.idempotencyKey};
  const existing=await config.ordersPool.query(
   'SELECT id FROM tala_core_v2.orders '+
   'WHERE buyer_id=$1::uuid AND idempotency_key=$2',
   [buyerId,input.idempotencyKey]);
  // Existing M1 orders can be replayed without requiring M6 stock
  // equality (M1 already decremented its own inventory once).
  if(!existing.rowCount){
   const checked=await previewInTransaction(config,cart,c);
   if(checked.m1Cart.restaurantId!==m1Input.restaurantId)
    throw new IntegrationError('M11_M1_QUOTE_DIVERGENCE');
  }
  const result=await createCashOrder(config.ordersPool,buyerId,m1Input);
  if(result.order.buyerId!==buyerId||
   result.order.restaurantId!==mapped.restaurantId||
   result.order.fulfillment!=='pickup'||
   result.order.paymentStatus!=='pending'||
   result.order.paymentMethod!=='cash')
   throw new IntegrationError('M11_ORDER_CONTRACT_INVALID');
  return Object.freeze({orderId:result.order.id,
   totalMinor:result.order.totalMinor,
   lines:result.order.lines,replayed:result.replayed,
   m6StockReserved:false as const,
   inventoryNeedsReconciliation:true as const,
   paid:false as const,commercialReady:false as const,
   policyApproved:false as const,source:'real_m1_cash_checkout_lab' as const});
 });
}
