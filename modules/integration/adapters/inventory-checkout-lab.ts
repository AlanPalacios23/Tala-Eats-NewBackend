/** M11 LAB6 checkout coordinator. Strictly TEST databases and no LIVE HTTP.
 * M6 branch inventory is the source of truth for HOLD; M1 remains a
 * legacy mirror with independent stock. This is not atomic across DBs.
 * Durable M11 intent + M6 hold allow recovery from process failure.
 */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {createCashOrder,type CreateInput,type OrderView} from
 '../../../src/modules/orders/checkout.ts';
import {quoteOrder} from '../../../src/modules/orders/pricing.ts';
import {IntegrationError,validUuid} from '../src/events.js';
import {normalizedCart,resolveLinkedBuyer,previewLinkedM6M1Pickup,
 type CatalogLabConfig,type LinkedPickupCart} from './catalog-checkout-lab.js';
import {reserveM6BranchStock,confirmM6BranchStock,
 releaseM6BranchStock,inspectM6StockHold,
 type ReserveLine} from '../m6-extension/reservations.js';

type IntentState='started'|'reserved'|'confirmed'|'released'|'review';
type IntentRow={intent_id:string,buyer_m1_id:string,
 idempotency_key:string,request_hash:string,store_id:string,
 branch_id:string,state:IntentState,m1_order_id:string|null};
type MappedLine={variantId:string,productId:string,quantity:number,
 expectedVersion:number};
type MappedOrder={restaurantId:string,lines:MappedLine[]};
type Fault='after_reservation'|'after_m1_commit';
const integrationDb='tala_integration_v2_test';
function noLive(){
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
}
function keyValid(key:unknown):key is string{
 return typeof key==='string'&&/^[a-zA-Z0-9_.:-]{16,128}$/.test(key);
}
function hashCart(cart:LinkedPickupCart){
 return createHash('sha256').update(JSON.stringify({
  storeId:cart.storeId,branchId:cart.branchId,
  lines:[...cart.lines].sort((a,b)=>a.variantId.localeCompare(b.variantId)),
  fulfillment:'pickup',paymentMethod:'cash'
 })).digest('hex');
}
async function ensureIntegration(c:PoolClient){
 noLive();
 const r=await c.query<{name:string}>('SELECT current_database() AS name');
 if(r.rows[0]?.name!==integrationDb)
  throw new IntegrationError('M11_LAB_ONLY');
}
async function getIntent(c:PoolClient,buyerId:string,key:string){
 const r=await c.query<IntentRow>(
  'SELECT intent_id,buyer_m1_id,idempotency_key,request_hash,store_id,'+
  'branch_id,state,m1_order_id FROM '+
  'tala_integration_v2.inventory_checkout_intents '+
  'WHERE buyer_m1_id=$1::uuid AND idempotency_key=$2',
  [buyerId,key]);
 return r.rows[0]??null;
}
async function ensureIntent(c:PoolClient,buyerId:string,key:string,
 cart:LinkedPickupCart){
 const fingerprint=hashCart(cart);
 await c.query(
  'INSERT INTO tala_integration_v2.inventory_checkout_intents '+
  '(buyer_m1_id,idempotency_key,request_hash,store_id,branch_id) '+
  'VALUES($1::uuid,$2,$3,$4::uuid,$5::uuid) '+
  'ON CONFLICT(buyer_m1_id,idempotency_key) DO NOTHING',
  [buyerId,key,fingerprint,cart.storeId,cart.branchId]);
 const intent=await getIntent(c,buyerId,key);
 if(!intent||intent.request_hash!==fingerprint||
  intent.store_id!==cart.storeId||intent.branch_id!==cart.branchId)
  throw new IntegrationError('M11_INTENT_IDEMPOTENCY_CONFLICT');
 await c.query(
  "INSERT INTO tala_integration_v2.inventory_intent_events "+
  "(intent_id,event_type) VALUES($1::uuid,'intent.started') "+
  "ON CONFLICT(intent_id,event_type) DO NOTHING",[intent.intent_id]);
 return intent;
}
async function stage(c:PoolClient,intent:IntentRow,
 next:IntentState,orderId:string|null=null){
 const r=await c.query(
  'UPDATE tala_integration_v2.inventory_checkout_intents SET '+
  'state=$2,m1_order_id=COALESCE($3::uuid,m1_order_id),'+
  'updated_at=clock_timestamp() WHERE intent_id=$1::uuid '+
  'AND state<>$2',[intent.intent_id,next,orderId]);
 if(r.rowCount){
  await c.query(
   'INSERT INTO tala_integration_v2.inventory_intent_events '+
   '(intent_id,event_type) VALUES($1::uuid,$2) '+
   'ON CONFLICT(intent_id,event_type) DO NOTHING',
   [intent.intent_id,'intent.'+next]);
 }
}
async function mapped(c:PoolClient,cart:LinkedPickupCart):Promise<MappedOrder>{
 const r=await c.query<{m6_variant_id:string,m1_product_id:string,
  m1_restaurant_id:string}>(
  'SELECT m6_variant_id,m1_product_id,m1_restaurant_id '+
  'FROM tala_integration_v2.variant_catalog_links '+
  'WHERE m6_store_id=$1::uuid AND m6_branch_id=$2::uuid '+
  'AND m6_variant_id=ANY($3::uuid[])',
  [cart.storeId,cart.branchId,cart.lines.map(x=>x.variantId)]);
 if(r.rows.length!==cart.lines.length)
  throw new IntegrationError('M11_VARIANT_NOT_MAPPED');
 const restaurantId=r.rows[0]!.m1_restaurant_id;
 if(r.rows.some(x=>x.m1_restaurant_id!==restaurantId))
  throw new IntegrationError('M11_MERCHANT_MAPPING_CONFLICT');
 const lookup=new Map(r.rows.map(x=>[x.m6_variant_id,x.m1_product_id]));
 return {restaurantId,
  lines:cart.lines.map(x=>{
   const productId=lookup.get(x.variantId);
   if(!productId)throw new IntegrationError('M11_VARIANT_NOT_MAPPED');
   return {variantId:x.variantId,productId,quantity:x.quantity,
    expectedVersion:x.expectedVariantVersion};
  })};
}
function m1Input(mappedOrder:MappedOrder,key:string):CreateInput{
 return {restaurantId:mappedOrder.restaurantId,fulfillment:'pickup',
  paymentMethod:'cash',
  lines:mappedOrder.lines.map(x=>({productId:x.productId,quantity:x.quantity})),
  idempotencyKey:key};
}
async function m1Committed(pool:Pool,buyerId:string,key:string){
 const db=await pool.query<{name:string}>('SELECT current_database() AS name');
 if(db.rows[0]?.name!=='tala_core_v2_test')
  throw new IntegrationError('M11_M1_LAB_ONLY');
 const r=await pool.query<{id:string}>(
  'SELECT id FROM tala_core_v2.orders '+
  'WHERE buyer_id=$1::uuid AND idempotency_key=$2',
  [buyerId,key]);
 return r.rows[0]?.id??null;
}
type Held=NonNullable<Awaited<ReturnType<typeof inspectM6StockHold>>>;
function assertHoldMatches(hold:Held,order:MappedOrder){
 if(hold.lines.length!==order.lines.length)
  throw new IntegrationError('M11_HOLD_LINES_MISMATCH');
 const rows=new Map(hold.lines.map(x=>[x.variantId,x]));
 for(const line of order.lines){
  const saved=rows.get(line.variantId);
  if(!saved||saved.quantity!==line.quantity||
     saved.variantVersion!==line.expectedVersion)
   throw new IntegrationError('M11_HOLD_LINES_MISMATCH');
 }
}
function verifyOrder(order:OrderView,hold:Held,mappedOrder:MappedOrder,
 buyerId:string){
 if(order.buyerId!==buyerId||
  order.restaurantId!==mappedOrder.restaurantId||
  order.paymentMethod!=='cash'||order.fulfillment!=='pickup'||
  order.paymentStatus!=='pending')
  throw new IntegrationError('M11_M1_ORDER_CONTRACT_DRIFT');
 if(order.lines.length!==hold.lines.length)
  throw new IntegrationError('M11_M1_ORDER_CONTRACT_DRIFT');
 const physical=new Map(mappedOrder.lines.map(x=>[
  x.productId,hold.lines.find(y=>y.variantId===x.variantId)
 ]));
 // M1 rows use the order's input line order; compare every M1 line.
 const expected=mappedOrder.lines.map(x=>{
  const h=physical.get(x.productId);
  if(!h)throw new IntegrationError('M11_HOLD_LINES_MISMATCH');
  return {quantity:x.quantity,name:h.name,unitMinor:h.priceMinor};
 });
 if(!order.lines.every((line,i)=>{
  const e=expected[i]!;
  return line.quantity===e.quantity&&
   line.name===e.name&&line.unitMinor===e.unitMinor;
 }))
  throw new IntegrationError('M11_M1_ORDER_CONTRACT_DRIFT');
 const quoted=quoteOrder({lines:expected.map(x=>({
  unitMinor:BigInt(x.unitMinor),quantity:x.quantity
 })),fulfillment:'pickup',deliveryFeeMinor:0n,
  driverBaseMinor:0n,tipMinor:0n});
 if(order.totalMinor!==quoted.totalMinor.toString())
  throw new IntegrationError('M11_M1_ORDER_TOTAL_DRIFT');
}
function publicResult(order:OrderView,holdId:string,replayed:boolean){
 return Object.freeze({
  holdId,orderId:order.id,totalMinor:order.totalMinor,
  replayed,inventoryOwner:'m6_branch_stock' as const,
  m6StockHeld:true as const,holdConfirmed:true as const,
  m1LegacyMirror:true as const,m1RequiresRetirement:true as const,
  paymentConfirmed:false as const,policyApproved:false as const,
  commercialReady:false as const,source:'m11_lab6_recoverable' as const
 });
}
/** One durable coordinator lock across both DB transactions. Locks live
 * on the M11 connection, NOT in the individual M6/M1 databases. */
async function withCoordinator<T>(config:CatalogLabConfig,
 sessionToken:string,key:string,
 task:(c:PoolClient,buyerId:string)=>Promise<T>){
 noLive();
 const c=await config.integrationPool.connect();
 let lockKey:string|null=null;
 try{
  await ensureIntegration(c);
  const buyerId=await resolveLinkedBuyer(config,sessionToken,c);
  lockKey=buyerId+'|'+key;
  await c.query('SELECT pg_advisory_lock(hashtextextended($1,7651))',
   [lockKey]);
  return await task(c,buyerId);
 }finally{
  if(lockKey!==null){
   try{await c.query('SELECT pg_advisory_unlock(hashtextextended($1,7651))',
     [lockKey]);}catch{ /* connection closure releases session lock */ }
  }
  c.release();
 }
}
export async function createReservedLabPickup(config:CatalogLabConfig,input:{
 sessionToken:string,cart:LinkedPickupCart,idempotencyKey:string,
 labFaultAfter?:Fault
}){
 noLive();
 if(!keyValid(input.idempotencyKey))
  throw new IntegrationError('M11_CHECKOUT_KEY_INVALID');
 const cart=normalizedCart(input.cart);
 return withCoordinator(config,input.sessionToken,input.idempotencyKey,
  async(c,buyerId)=>{
   const intent=await ensureIntent(c,buyerId,input.idempotencyKey,cart);
   if(intent.state==='released')
    throw new IntegrationError('M11_INTENT_RELEASED');
   if(intent.state==='review')
    throw new IntegrationError('M11_MANUAL_RECONCILIATION_REQUIRED');
   const links=await mapped(c,cart),m1=m1Input(links,input.idempotencyKey);
   let hold=await inspectM6StockHold(config.restaurantsPool,intent.intent_id);
   const existing=await m1Committed(config.ordersPool,buyerId,input.idempotencyKey);
   if(existing){
    // M1's own idempotency compares the original payload before readback.
    const replay=await createCashOrder(config.ordersPool,buyerId,m1);
    if(replay.order.id!==existing||!hold||hold.state==='released'){
     await stage(c,intent,'review',existing);
     throw new IntegrationError('M11_MANUAL_RECONCILIATION_REQUIRED');
    }
    try{assertHoldMatches(hold,links);
     verifyOrder(replay.order,hold,links,buyerId);
    }catch{
     await stage(c,intent,'review',existing);
     throw new IntegrationError('M11_MANUAL_RECONCILIATION_REQUIRED');
    }
    await confirmM6BranchStock(config.restaurantsPool,intent.intent_id,existing);
    await stage(c,intent,'confirmed',existing);
    return publicResult(replay.order,intent.intent_id,true);
   }
   if(intent.state==='confirmed'){
    await stage(c,intent,'review');
    throw new IntegrationError('M11_MANUAL_RECONCILIATION_REQUIRED');
   }
   if(hold){
    if(hold.state!=='reserved'){
     await stage(c,intent,'review');
     throw new IntegrationError('M11_MANUAL_RECONCILIATION_REQUIRED');
    }
    assertHoldMatches(hold,links);
    if(new Date(hold.expiresAt).getTime()<=Date.now())
     throw new IntegrationError('M11_HOLD_EXPIRED_NEEDS_RECONCILIATION');
   }else{
    // No reservation yet: strict M6 / M1 price and stock equality check.
    const offer=await previewLinkedM6M1Pickup(config,cart);
    const reservationLines:ReserveLine[]=offer.lines.map(x=>({
     variantId:x.variantId,quantity:x.quantity,
     expectedVersion:x.expectedVersion,
     expectedPriceMinor:x.unitMinor,expectedName:x.name
    }));
    const reserved=await reserveM6BranchStock(config.restaurantsPool,{
     holdId:intent.intent_id,storeId:cart.storeId,branchId:cart.branchId,
     lines:reservationLines,ttlSeconds:300
    });
    if(reserved.state!=='reserved')
     throw new IntegrationError('M11_HOLD_NOT_RESERVED');
    hold=await inspectM6StockHold(config.restaurantsPool,intent.intent_id);
   }
   if(!hold)throw new IntegrationError('M11_HOLD_NOT_FOUND');
   await stage(c,intent,'reserved');
   if(input.labFaultAfter==='after_reservation')
    throw new IntegrationError('M11_TEST_INJECTED_CRASH');
   try{
    const result=await createCashOrder(config.ordersPool,buyerId,m1);
    if(input.labFaultAfter==='after_m1_commit')
     throw new IntegrationError('M11_TEST_INJECTED_CRASH');
    try{
     verifyOrder(result.order,hold,links,buyerId);
    }catch{
     await stage(c,intent,'review',result.order.id);
     throw new IntegrationError('M11_MANUAL_RECONCILIATION_REQUIRED');
    }
    await confirmM6BranchStock(config.restaurantsPool,
     intent.intent_id,result.order.id);
    await stage(c,intent,'confirmed',result.order.id);
    return publicResult(result.order,intent.intent_id,result.replayed);
   }catch(err){
    if(err instanceof IntegrationError&&
      (err.code==='M11_TEST_INJECTED_CRASH'||
       err.code==='M11_MANUAL_RECONCILIATION_REQUIRED'))
     throw err;
    // The M1 call can fail after its COMMIT. Never release the hold
    // until a successful M1 lookup has established NO order exists.
    let committed:string|null;
    try{committed=await m1Committed(config.ordersPool,buyerId,
     input.idempotencyKey);
    }catch{
     await stage(c,intent,'review');
     throw new IntegrationError('M11_MANUAL_RECONCILIATION_REQUIRED');
    }
    if(committed){
     await stage(c,intent,'review',committed);
     throw new IntegrationError('M11_MANUAL_RECONCILIATION_REQUIRED');
    }
    try{
     await releaseM6BranchStock(config.restaurantsPool,intent.intent_id);
     await stage(c,intent,'released');
    }catch{
     await stage(c,intent,'review');
     throw new IntegrationError('M11_MANUAL_RECONCILIATION_REQUIRED');
    }
    throw err;
   }
  });
}
/** Explicit recovery / TTL sweep: never use TTL alone as evidence of no M1
 * order. Reads M1 under same M11 session lock before releasing physical stock.
 */
export async function reconcileReservedLabIntent(config:CatalogLabConfig,input:{
 sessionToken:string,idempotencyKey:string,cart:LinkedPickupCart,
 releaseIfExpired?:boolean
}){
 noLive();
 if(!keyValid(input.idempotencyKey))
  throw new IntegrationError('M11_CHECKOUT_KEY_INVALID');
 const cart=normalizedCart(input.cart);
 return withCoordinator(config,input.sessionToken,input.idempotencyKey,
  async(c,buyerId)=>{
   const intent=await getIntent(c,buyerId,input.idempotencyKey);
   if(!intent||intent.request_hash!==hashCart(cart))
    throw new IntegrationError('M11_INTENT_NOT_FOUND');
   if(intent.state==='released')
    return Object.freeze({state:'released' as const,replayed:true as const});
   const hold=await inspectM6StockHold(config.restaurantsPool,intent.intent_id);
   if(!hold)throw new IntegrationError('M11_HOLD_NOT_FOUND');
   const links=await mapped(c,cart),m1=m1Input(links,input.idempotencyKey);
   const existing=await m1Committed(config.ordersPool,buyerId,
    input.idempotencyKey);
   if(existing){
    if(hold.state==='released'){
     await stage(c,intent,'review',existing);
     throw new IntegrationError('M11_MANUAL_RECONCILIATION_REQUIRED');
    }
    const replay=await createCashOrder(config.ordersPool,buyerId,m1);
    try{assertHoldMatches(hold,links);
     verifyOrder(replay.order,hold,links,buyerId);
    }catch{
     await stage(c,intent,'review',existing);
     throw new IntegrationError('M11_MANUAL_RECONCILIATION_REQUIRED');
    }
    await confirmM6BranchStock(config.restaurantsPool,intent.intent_id,existing);
    await stage(c,intent,'confirmed',existing);
    return Object.freeze({state:'confirmed' as const,
     orderId:existing,paid:false as const,commercialReady:false as const});
   }
   if(hold.state==='confirmed'||intent.state==='confirmed'){
    await stage(c,intent,'review');
    throw new IntegrationError('M11_MANUAL_RECONCILIATION_REQUIRED');
   }
   if(input.releaseIfExpired===true&&
      Date.now()>=new Date(hold.expiresAt).getTime()){
    await releaseM6BranchStock(config.restaurantsPool,intent.intent_id);
    await stage(c,intent,'released');
    return Object.freeze({state:'released' as const,
     restored:true as const,commercialReady:false as const});
   }
   return Object.freeze({state:'reserved' as const,
    pendingManualCheck:true as const,commercialReady:false as const});
  });
}
