/** M11 LAB8 Stripe TEST checkout coordinator. Separate from CASH LAB7.
 * Only test DBs, no REAL money, no payout and no public HTTP endpoint.
 * M1's createStripeOrder port is temporarily in m1-extension; must move
 * into domain-owned M1 before production. M6 hold is provisional until
 * signed Stripe TEST evidence is persisted in M8 and applied to M1.
 */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {readAuthenticatedProfile} from '../../users/src/auth.js';
import {createM8TestPayment,readM8TestPayment,issueM8TestIntent,
 type M8TestClient} from './m8-test-boundary.js';
import {createLabM1StripeAwaitingPayment,
 commitVerifiedLabStripePayment,type FrozenOfferLine}
 from '../m1-extension/stripe-test-orders.js';
import {reserveM6BranchStock,inspectM6StockHold,
 confirmM6BranchStock,type ReserveLine}
 from '../m6-extension/reservations.js';
import {normalizedCart,resolveLinkedBuyer,previewLinkedM6M1Pickup,
 type CatalogLabConfig,type LinkedPickupCart} from './catalog-checkout-lab.js';
import {IntegrationError,validUuid} from '../src/events.js';

export type StripeTestLabConfig=CatalogLabConfig&{paymentsPool:Pool};
type Intent={intent_id:string,m4_customer_id:string,m1_buyer_id:string,
 idempotency_key:string,request_hash:string,store_id:string,
 branch_id:string,m1_order_id:string|null,m8_payment_id:string|null,
 state:string};
const assertLab=()=>{
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
};
const validKey=(s:unknown):s is string=>
 typeof s==='string'&&/^[a-zA-Z0-9_.:-]{16,128}$/.test(s);
const cartDigest=(c:LinkedPickupCart)=>createHash('sha256')
 .update(JSON.stringify({
  storeId:c.storeId,branchId:c.branchId,
  lines:[...c.lines].sort((a,b)=>a.variantId.localeCompare(b.variantId)),
  paymentMethod:'stripe_test',fulfillment:'pickup'
 })).digest('hex');
async function db(pool:Pool,dbname:string){
 assertLab();
 const d=await pool.query<{name:string}>('SELECT current_database() AS name');
 if(d.rows[0]?.name!==dbname)throw new IntegrationError('M11_LAB_ONLY');
}
async function dbClient(c:PoolClient,dbname:string){
 const d=await c.query<{name:string}>('SELECT current_database() AS name');
 if(d.rows[0]?.name!==dbname)throw new IntegrationError('M11_LAB_ONLY');
}
async function holdLock<T>(config:StripeTestLabConfig,token:string,key:string,
 work:(c:PoolClient,buyerId:string,m4Id:string)=>Promise<T>):Promise<T>{
 assertLab();
 const c=await config.integrationPool.connect();
 let lockName:string|null=null;
 try{
  await dbClient(c,'tala_integration_v2_test');
  const buyerId=await resolveLinkedBuyer(config,token,c);
  const user=await readAuthenticatedProfile(config.usersPool,{
   sessionToken:token,secret:config.usersPasswordPepper
  }).catch(()=>null);
  if(!user)throw new IntegrationError('M11_IDENTITY_NOT_AUTHENTICATED');
  const m4Id=validUuid(user.id);
  lockName='stripe-v1|'+buyerId+'|'+key;
  await c.query('SELECT pg_advisory_lock(hashtextextended($1,8810))',
   [lockName]);
  return await work(c,buyerId,m4Id);
 }finally{
  if(lockName!==null)try{
   await c.query('SELECT pg_advisory_unlock(hashtextextended($1,8810))',
    [lockName]);
  }catch{}
  c.release();
 }
}
async function byKey(c:PoolClient,buyerId:string,key:string){
 const q=await c.query<Intent>(
  'SELECT * FROM tala_integration_v2.stripe_test_checkout_intents '+
  'WHERE m1_buyer_id=$1::uuid AND idempotency_key=$2',[buyerId,key]);
 return q.rows[0]??null;
}
async function byId(c:PoolClient,id:string){
 const q=await c.query<Intent>(
  'SELECT * FROM tala_integration_v2.stripe_test_checkout_intents '+
  'WHERE intent_id=$1::uuid',[id]);
 return q.rows[0]??null;
}
async function event(c:PoolClient,intentId:string,state:string){
 const type='stripe.'+state;
 if(!['stripe.started','stripe.reserved','stripe.order_created',
  'stripe.payment_created','stripe.verified','stripe.review'].includes(type))
  throw new IntegrationError('M11_STRIPE_INTENT_STATE_INVALID');
 await c.query('INSERT INTO tala_integration_v2.stripe_test_intent_events '+
  '(intent_id,event_type) VALUES($1::uuid,$2) '+
  'ON CONFLICT(intent_id,event_type) DO NOTHING',[intentId,type]);
}
async function update(c:PoolClient,intentId:string,state:string,
 orderId?:string,paymentId?:string){
 await c.query('UPDATE tala_integration_v2.stripe_test_checkout_intents '+
  'SET state=$2,m1_order_id=COALESCE($3::uuid,m1_order_id),'+
  'm8_payment_id=COALESCE($4::uuid,m8_payment_id),'+
  'updated_at=clock_timestamp() WHERE intent_id=$1::uuid',
  [intentId,state,orderId??null,paymentId??null]);
 await event(c,intentId,state);
}
async function ensure(c:PoolClient,cart:LinkedPickupCart,
 buyerId:string,m4Id:string,key:string){
 const digest=cartDigest(cart);
 await c.query(
  'INSERT INTO tala_integration_v2.stripe_test_checkout_intents '+
  '(m4_customer_id,m1_buyer_id,idempotency_key,request_hash,store_id,branch_id) '+
  'VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid) '+
  'ON CONFLICT(m1_buyer_id,idempotency_key) DO NOTHING',
  [m4Id,buyerId,key,digest,cart.storeId,cart.branchId]);
 const found=await byKey(c,buyerId,key);
 if(!found||found.request_hash!==digest||
    found.m4_customer_id!==m4Id||
    found.store_id!==cart.storeId||
    found.branch_id!==cart.branchId)
  throw new IntegrationError('M11_STRIPE_IDEMPOTENCY_CONFLICT');
 if(found.state==='review')
  throw new IntegrationError('M11_MANUAL_RECONCILIATION_REQUIRED');
 await event(c,found.intent_id,'started');
 return found;
}
async function mapping(c:PoolClient,cart:LinkedPickupCart){
 const q=await c.query<{m6_variant_id:string,m1_product_id:string,
  m1_restaurant_id:string}>(
  'SELECT m6_variant_id,m1_product_id,m1_restaurant_id FROM '+
  'tala_integration_v2.variant_catalog_links '+
  'WHERE m6_store_id=$1::uuid AND m6_branch_id=$2::uuid '+
  'AND m6_variant_id=ANY($3::uuid[])',
  [cart.storeId,cart.branchId,cart.lines.map(x=>x.variantId)]);
 if(q.rows.length!==cart.lines.length)
  throw new IntegrationError('M11_VARIANT_NOT_MAPPED');
 const restaurantId=q.rows[0]!.m1_restaurant_id;
 if(q.rows.some(x=>x.m1_restaurant_id!==restaurantId))
  throw new IntegrationError('M11_MERCHANT_MAPPING_CONFLICT');
 const m=new Map(q.rows.map(x=>[x.m6_variant_id,x.m1_product_id]));
 return {restaurantId,links:cart.lines.map(x=>{
  const productId=m.get(x.variantId);
  if(!productId)throw new IntegrationError('M11_VARIANT_NOT_MAPPED');
  return {variantId:x.variantId,productId,quantity:x.quantity,
   expectedVersion:x.expectedVariantVersion};
 })};
}
async function m1ByKey(pool:Pool,buyerId:string,key:string){
 await db(pool,'tala_core_v2_test');
 const q=await pool.query<{id:string,total_minor:string,
  payment_method:string,status:string}>(
  'SELECT id,total_minor::text,payment_method,status FROM '+
  'tala_core_v2.orders WHERE buyer_id=$1::uuid AND idempotency_key=$2',
  [buyerId,key]);
 return q.rows[0]??null;
}
/** Produce an internal pending Stripe TEST PaymentIntent, no card charged.
 * On ambiguous network outcomes, M8's lease/operation ID remains durable;
 * do not release M6 inventory or create a second provider payment.
 */
export async function startStripeTestLabPickup(config:StripeTestLabConfig,
 client:M8TestClient,input:{m4SessionToken:string,
 cart:LinkedPickupCart,idempotencyKey:string}){
 assertLab();
 if(!validKey(input.idempotencyKey))
  throw new IntegrationError('M11_STRIPE_KEY_INVALID');
 const cart=normalizedCart(input.cart);
 await Promise.all([
  db(config.paymentsPool,'tala_payments_v2_test'),
  db(config.restaurantsPool,'tala_restaurants_v2_test'),
  db(config.ordersPool,'tala_core_v2_test')
 ]);
 return holdLock(config,input.m4SessionToken,input.idempotencyKey,
  async(c,buyerId,m4Id)=>{
   const i=await ensure(c,cart,buyerId,m4Id,input.idempotencyKey);
   const mapped=await mapping(c,cart);
   let hold=await inspectM6StockHold(config.restaurantsPool,i.intent_id);
   if(!hold){
    const before=await previewLinkedM6M1Pickup(config,cart);
    const lines:ReserveLine[]=before.lines.map(x=>({
     variantId:x.variantId,quantity:x.quantity,
     expectedVersion:x.expectedVersion,expectedPriceMinor:x.unitMinor,
     expectedName:x.name
    }));
    await reserveM6BranchStock(config.restaurantsPool,{
     holdId:i.intent_id,storeId:cart.storeId,branchId:cart.branchId,
     lines,ttlSeconds:300});
    await update(c,i.intent_id,'reserved');
    hold=await inspectM6StockHold(config.restaurantsPool,i.intent_id);
   }
   if(!hold||hold.state==='released')
    throw new IntegrationError('M11_STRIPE_HOLD_UNAVAILABLE');
   if(hold.lines.length!==mapped.links.length||
      mapped.links.some(x=>{
       const row=hold!.lines.find(y=>y.variantId===x.variantId);
       return !row||row.quantity!==x.quantity||
        row.variantVersion!==x.expectedVersion;
      }))throw new IntegrationError('M11_STRIPE_HOLD_MISMATCH');
   const frozen:FrozenOfferLine[]=mapped.links.map(x=>{
    const line=hold!.lines.find(y=>y.variantId===x.variantId)!;
    return {productId:x.productId,quantity:x.quantity,
     name:line.name,unitMinor:line.priceMinor};
   });
   const order=await createLabM1StripeAwaitingPayment(
    config.ordersPool,buyerId,{restaurantId:mapped.restaurantId,
     lines:frozen,idempotencyKey:input.idempotencyKey});
   if(i.m1_order_id!==null&&i.m1_order_id!==order.orderId)
    throw new IntegrationError('M11_STRIPE_M1_ORDER_CONFLICT');
   await update(c,i.intent_id,'order_created',order.orderId);
   const money=Number(order.totalMinor);
   const payment=await createM8TestPayment(config.paymentsPool,{
    actorId:m4Id,canCreatePayments:true},{
    operationId:i.intent_id,orderRef:order.orderId,
    customerRef:m4Id,amountCents:money,currency:'MXN'});
   if(i.m8_payment_id!==null&&i.m8_payment_id!==payment.id)
    throw new IntegrationError('M11_STRIPE_M8_PAYMENT_CONFLICT');
   await update(c,i.intent_id,'payment_created',order.orderId,payment.id);
   const provider=await issueM8TestIntent(config.paymentsPool,client,{
    actorId:m4Id,canCreatePayments:true},payment.id);
   if(provider.livemode!==false||provider.provider!=='stripe_test')
    throw new IntegrationError('M11_LIVE_PAYMENT_FORBIDDEN');
   return Object.freeze({intentId:i.intent_id,orderId:order.orderId,
    paymentId:payment.id,intentIdStripe:provider.intentId,
    clientSecret:provider.clientSecret,
    paymentStatus:payment.state,orderStatus:order.status,
    provider:'stripe_test' as const,testOnly:true as const,
    m6HoldConfirmed:false as const,
    commercialReady:false as const,policyApproved:false as const});
  });
}
/** Reads only VERIFIED Stripe TEST facts inside M8. Never accept a
 * browser-reported 'paid', a simulated_lab provider fact or a secret.
 */
export async function reconcileStripeTestLabPickup(config:StripeTestLabConfig,
 trusted:{authenticated?:boolean,canReconcileStripeTest?:boolean},
 intentId:string){
 assertLab();
 if(trusted?.authenticated!==true||trusted.canReconcileStripeTest!==true)
  throw new IntegrationError('M11_STRIPE_RECONCILIATION_FORBIDDEN');
 const id=validUuid(intentId);
 await Promise.all([db(config.integrationPool,'tala_integration_v2_test'),
  db(config.ordersPool,'tala_core_v2_test'),
  db(config.paymentsPool,'tala_payments_v2_test')]);
 const c=await config.integrationPool.connect();
 try{
  const i=await byId(c,id);
  if(!i||!i.m1_order_id||!i.m8_payment_id)
   throw new IntegrationError('M11_STRIPE_PAYMENT_NOT_LINKED');
  const lock=i.m1_buyer_id+'|'+i.idempotency_key;
  await c.query('SELECT pg_advisory_lock(hashtextextended($1,8810))',
   ['stripe-v1|'+lock]);
  try{
   const p=await readM8TestPayment(config.paymentsPool,{
    actorId:i.m4_customer_id,
    canReadPayments:true,canReadAllPayments:true},i.m8_payment_id);
   const order=await config.ordersPool.query<{id:string,
    buyer_id:string,restaurant_id:string,total_minor:string,
    payment_method:string,status:string,price_snapshot:Record<string,unknown>}>(
    'SELECT id,buyer_id,restaurant_id,total_minor::text,'+
    'payment_method,status,price_snapshot FROM tala_core_v2.orders '+
    'WHERE id=$1::uuid',[i.m1_order_id]);
   const row=order.rows[0];
   if(!row||row.buyer_id!==i.m1_buyer_id||
      row.payment_method!=='stripe'||p.provider!=='stripe_test'||
      p.orderRef!==row.id||p.customerRef!==i.m4_customer_id||
      p.currency!=='MXN'||String(p.amountCents)!==row.total_minor)
    throw new IntegrationError('M11_STRIPE_PAYMENT_ORDER_MISMATCH');
   const proof=p.stripeTestFacts.some(x=>
    x.type==='FundsConfirmed.v1'&&x.source==='stripe_test'&&
    x.refundId===null&&x.amountCents===p.amountCents);
   if(p.state!=='succeeded'||!proof)
    return Object.freeze({status:'awaiting_verified_test_webhook' as const,
     commercialReady:false as const,paymentConfirmed:false as const});
   const current=await byId(c,id);
   if(current?.m1_order_id!==row.id||
      current?.m8_payment_id!==p.id)
    throw new IntegrationError('M11_STRIPE_INTENT_CONFLICT');
   const saved=await commitVerifiedLabStripePayment(config.ordersPool,{
    orderId:row.id,paymentId:p.id,amountCents:p.amountCents,
    source:'stripe_test_verified_in_m8_lab'
   });
   await confirmM6BranchStock(config.restaurantsPool,id,row.id);
   await update(c,id,'verified',row.id,p.id);
   return Object.freeze({status:'received' as const,
    orderId:row.id,paymentId:p.id,verified:true as const,
    replayed:saved.replayed,
    inventoryHeld:true as const,livePayment:false as const,
    commercialReady:false as const,policyApproved:false as const});
  }finally{
   await c.query('SELECT pg_advisory_unlock(hashtextextended($1,8810))',
    ['stripe-v1|'+lock]);
  }
 }finally{c.release();}
}
