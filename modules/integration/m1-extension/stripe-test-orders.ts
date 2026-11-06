/** TEMPORARY M1 TEST-only Stripe checkout extension, NOT part of original M1.
 * A M1-owned createStripeOrder port is a prerequisite before production.
 * Never call from a public endpoint. No Stripe SDK/network or real charges.
 */
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {quoteOrder} from '../../../src/modules/orders/pricing.ts';
import {validateCart} from '../../../src/modules/orders/checkout.ts';
import {IntegrationError,validUuid} from '../src/events.js';

export type FrozenOfferLine={
 productId:string,name:string,unitMinor:string,quantity:number
};
export type StripeLabOrderInput={
 restaurantId:string,lines:FrozenOfferLine[],idempotencyKey:string
};
const guard=()=>{
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
};
function canonical(input:StripeLabOrderInput){
 const restaurantId=validUuid(input.restaurantId);
 if(!Array.isArray(input.lines)||input.lines.length<1||input.lines.length>50||
   typeof input.idempotencyKey!=='string'||
   !/^[a-zA-Z0-9_.:-]{16,128}$/.test(input.idempotencyKey))
  throw new IntegrationError('M11_STRIPE_ORDER_INPUT_INVALID');
 const seen=new Set<string>();
 const lines=input.lines.map(l=>{
  const productId=validUuid(l.productId);
  if(seen.has(productId)||typeof l.name!=='string'||
    l.name.length<2||l.name.length>180||
    !/^[1-9][0-9]{0,8}$/.test(l.unitMinor)||
    !Number.isSafeInteger(l.quantity)||l.quantity<1||l.quantity>100)
   throw new IntegrationError('M11_STRIPE_ORDER_INPUT_INVALID');
  seen.add(productId);
  return {productId,name:l.name,unitMinor:l.unitMinor,quantity:l.quantity};
 });
 validateCart({restaurantId,fulfillment:'pickup',
  lines:lines.map(x=>({productId:x.productId,quantity:x.quantity}))});
 return {restaurantId,lines,idempotencyKey:input.idempotencyKey};
}
const hashInput=(input:ReturnType<typeof canonical>)=>createHash('sha256')
 .update(JSON.stringify({restaurantId:input.restaurantId,
  fulfillment:'pickup',paymentMethod:'stripe',lines:[...input.lines]
  .sort((a,b)=>a.productId.localeCompare(b.productId))})).digest('hex');
async function gated(c:{query:Pool['query']}){
 guard();
 const db=await c.query<{name:string}>('SELECT current_database() AS name');
 if(db.rows[0]?.name!=='tala_core_v2_test')
  throw new IntegrationError('M11_M1_LAB_ONLY');
}
/** Stock, lines, snapshot and outbox share the M1 transaction.
 * Expected amounts are cross-checked against LOCKED M1 catalog rows.
 */
export async function createLabM1StripeAwaitingPayment(pool:Pool,buyerId:string,
 raw:StripeLabOrderInput){
 guard();
 const buyer=validUuid(buyerId),input=canonical(raw),
  requestHash=hashInput(input);
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout='3000ms'");
  await c.query("SET LOCAL statement_timeout='12000ms'");
  await gated(c);
  const customer=await c.query(
   'SELECT 1 FROM tala_core_v2.accounts '+
   "WHERE id=$1::uuid AND role='customer' AND is_active=true FOR UPDATE",
   [buyer]);
  if(!customer.rowCount)
   throw new IntegrationError('M11_M1_BUYER_FORBIDDEN');
  const existing=await c.query<{id:string,request_hash:string,
   status:string,payment_method:string,total_minor:string}>(
   'SELECT id,request_hash,status,payment_method,total_minor::text '+
   'FROM tala_core_v2.orders WHERE buyer_id=$1::uuid '+
   'AND idempotency_key=$2 FOR UPDATE',[buyer,input.idempotencyKey]);
  if(existing.rows[0]){
   const old=existing.rows[0];
   if(old.request_hash!==requestHash||old.payment_method!=='stripe')
    throw new IntegrationError('M11_STRIPE_ORDER_IDEMPOTENCY_CONFLICT');
   await c.query('COMMIT');
   return Object.freeze({orderId:old.id,totalMinor:old.total_minor,
    status:old.status,paymentMethod:'stripe' as const,replayed:true});
  }
  const store=await c.query<{is_open:boolean}>(
   'SELECT is_open FROM tala_core_v2.restaurants WHERE id=$1::uuid FOR SHARE',
   [input.restaurantId]);
  if(!store.rows[0]?.is_open)
   throw new IntegrationError('M11_M1_RESTAURANT_UNAVAILABLE');
  const products=await c.query<{id:string,name:string,
   price_minor:string,stock:number,is_available:boolean}>(
   'SELECT id,name,price_minor::text,stock,is_available '+
   'FROM tala_core_v2.catalog_products '+
   'WHERE restaurant_id=$1::uuid AND id=ANY($2::uuid[]) '+
   'ORDER BY id FOR UPDATE',
   [input.restaurantId,input.lines.map(x=>x.productId)]);
  if(products.rows.length!==input.lines.length)
   throw new IntegrationError('M11_M1_PRODUCT_UNAVAILABLE');
  const lookup=new Map(products.rows.map(x=>[x.id,x]));
  for(const line of input.lines){
   const p=lookup.get(line.productId);
   if(!p||!p.is_available||p.name!==line.name||
      p.price_minor!==line.unitMinor||p.stock<line.quantity)
    throw new IntegrationError('M11_M1_OFFER_CHANGED');
  }
  const quote=quoteOrder({fulfillment:'pickup',
   lines:input.lines.map(x=>({
    unitMinor:BigInt(x.unitMinor),quantity:x.quantity
   })),deliveryFeeMinor:0n,driverBaseMinor:0n,tipMinor:0n});
  if(quote.totalMinor>100_000_000n)
   throw new IntegrationError('M11_STRIPE_AMOUNT_TOO_LARGE');
  const money=(n:bigint)=>n.toString();
  const snapshot={
   currency:'MXN',policyVersion:quote.policyVersion,
   fulfillment:'pickup',itemsMinor:money(quote.itemsMinor),
   merchantCommissionMinor:money(quote.merchantCommissionMinor),
   merchantPayableMinor:money(quote.merchantPayableMinor),
   serviceFeeMinor:money(quote.serviceFeeMinor),
   deliveryFeeMinor:money(quote.deliveryFeeMinor),
   driverPayableMinor:money(quote.driverPayableMinor),
   tipMinor:money(quote.tipMinor),totalMinor:money(quote.totalMinor),
   platformGrossMinor:money(quote.platformGrossMinor),
   lines:input.lines.map(x=>({...x}))
  };
  for(const line of input.lines){
   const result=await c.query(
    'UPDATE tala_core_v2.catalog_products SET stock=stock-$2,'+
    'updated_at=now() WHERE id=$1::uuid AND stock>=$2',
    [line.productId,line.quantity]);
   if(result.rowCount!==1)
    throw new IntegrationError('M11_M1_OFFER_CHANGED');
  }
  const inserted=await c.query<{id:string}>(
   'INSERT INTO tala_core_v2.orders ('+
   'buyer_id,restaurant_id,fulfillment,status,payment_method,'+
   'payment_status,total_minor,pricing_policy_version,price_snapshot,'+
   'idempotency_key,request_hash) VALUES ('+
   "$1::uuid,$2::uuid,'pickup','awaiting_payment','stripe','pending',"+
   '$3,$4,$5::jsonb,$6,$7) RETURNING id',
   [buyer,input.restaurantId,money(quote.totalMinor),
    quote.policyVersion,JSON.stringify(snapshot),input.idempotencyKey,
    requestHash]);
  const orderId=inserted.rows[0]!.id;
  for(const [i,line] of input.lines.entries()){
   await c.query(
    'INSERT INTO tala_core_v2.order_lines '+
    '(order_id,line_number,product_id,product_name_snapshot,'+
    'unit_minor,quantity) VALUES($1::uuid,$2,$3::uuid,$4,$5,$6)',
    [orderId,i+1,line.productId,line.name,line.unitMinor,line.quantity]);
  }
  const eventKey=createHash('sha256')
   .update('order.awaiting_payment|'+orderId).digest('hex');
  await c.query(
   'INSERT INTO tala_core_v2.order_events '+
   '(order_id,event_key,previous_status,new_status,actor_role,data) '+
   "VALUES($1::uuid,$2,NULL,'awaiting_payment','system','{}'::jsonb)",
   [orderId,eventKey]);
  await c.query(
   'INSERT INTO tala_core_v2.outbox '+
   '(aggregate_id,event_key,event_type,payload) '+
   "VALUES($1::uuid,$2,'order.awaiting_payment',$3::jsonb)",
   [orderId,eventKey,JSON.stringify({orderId,
    status:'awaiting_payment',method:'stripe_test_lab'})]);
  await c.query('COMMIT');
  return Object.freeze({orderId,totalMinor:money(quote.totalMinor),
   status:'awaiting_payment' as const,paymentMethod:'stripe' as const,
   replayed:false});
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;
 }finally{c.release();}
}
