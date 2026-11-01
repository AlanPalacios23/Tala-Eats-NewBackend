/** CORE v2 Orders — isolated cash checkout, no Stripe writes, no LIVE access. */
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {quoteOrder} from './pricing.ts';
import type {Fulfillment} from './order-machine.ts';

export class OrderServiceError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.code=code;this.name='OrderServiceError';}
}
export type CartLine={productId:string;quantity:number};
export type CartInput={restaurantId:string;fulfillment:Fulfillment;lines:CartLine[];deliveryAddress?:string};
export type CreateInput=CartInput&{idempotencyKey:string;paymentMethod:'cash'};
export type OrderView={
  id:string;restaurantId:string;buyerId:string;status:string;fulfillment:string;
  paymentMethod:string;paymentStatus:string;totalMinor:string;version:string;
  deliveryAddress:string|null;createdAt:string;
  lines:{name:string;quantity:number;unitMinor:string}[];
};
type Product={id:string;name:string;price_minor:string;stock:number;is_available:boolean};
type DbOrder={id:string;restaurant_id:string;buyer_id:string;status:string;
  fulfillment:string;payment_method:string;payment_status:string;total_minor:string;
  version:string;delivery_address:string|null;created_at:Date|string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money=(x:bigint)=>x.toString();
const checkoutHash=(input:CreateInput)=>createHash('sha256').update(JSON.stringify({
  restaurantId:input.restaurantId,fulfillment:input.fulfillment,
  lines:[...input.lines].map(l=>({productId:l.productId.toLowerCase(),quantity:l.quantity}))
    .sort((a,b)=>a.productId.localeCompare(b.productId)),
  deliveryAddress:input.deliveryAddress?.trim()??'',paymentMethod:input.paymentMethod
})).digest('hex');

export function validateCart(input:CartInput):void{
  if(!uuid.test(input.restaurantId)||!['pickup','delivery'].includes(input.fulfillment)
    ||!Array.isArray(input.lines)||input.lines.length<1||input.lines.length>50)
    throw new OrderServiceError('CART_INVALID');
  const ids=new Set<string>();
  for(const line of input.lines){
    if(!uuid.test(line.productId)||!Number.isSafeInteger(line.quantity)||line.quantity<1
      ||line.quantity>100||ids.has(line.productId.toLowerCase()))
      throw new OrderServiceError('CART_INVALID');
    ids.add(line.productId.toLowerCase());
  }
  if(input.fulfillment==='delivery'&&
    (!input.deliveryAddress||input.deliveryAddress.trim().length<5||
      input.deliveryAddress.trim().length>240))throw new OrderServiceError('ADDRESS_REQUIRED');
  if(input.fulfillment==='pickup'&&input.deliveryAddress?.trim())
    throw new OrderServiceError('PICKUP_HAS_NO_ADDRESS');
}
async function catalog(client:PoolClient,input:CartInput,lock:boolean):Promise<Product[]>{
  const store=await client.query<{is_open:boolean}>(`
    SELECT is_open FROM tala_core_v2.restaurants WHERE id=$1::uuid
    ${lock?'FOR SHARE':''}`,[input.restaurantId]);
  if(!store.rows[0]?.is_open)throw new OrderServiceError('RESTAURANT_UNAVAILABLE');
  const products=await client.query<Product>(`
    SELECT id,name,price_minor,stock,is_available FROM tala_core_v2.catalog_products
    WHERE restaurant_id=$1::uuid AND id=ANY($2::uuid[])
    ORDER BY id ${lock?'FOR UPDATE':''}`,
    [input.restaurantId,input.lines.map(l=>l.productId)]);
  if(products.rows.length!==input.lines.length)
    throw new OrderServiceError('PRODUCT_UNAVAILABLE');
  const lookup=new Map(products.rows.map(p=>[p.id,p]));
  for(const line of input.lines){
    const product=lookup.get(line.productId.toLowerCase());
    if(!product?.is_available||product.stock<line.quantity)
      throw new OrderServiceError('OUT_OF_STOCK');
  }
  return products.rows;
}
function buildQuote(input:CartInput,products:Product[]){
  const lookup=new Map(products.map(p=>[p.id,p]));
  const q=quoteOrder({
    lines:input.lines.map(l=>({
      unitMinor:BigInt(lookup.get(l.productId.toLowerCase())!.price_minor),quantity:l.quantity
    })),
    fulfillment:input.fulfillment,deliveryFeeMinor:input.fulfillment==='delivery'?3900n:0n,
    driverBaseMinor:input.fulfillment==='delivery'?3200n:0n,tipMinor:0n
  });
  return {policyVersion:q.policyVersion,itemsMinor:money(q.itemsMinor),
    serviceFeeMinor:money(q.serviceFeeMinor),deliveryFeeMinor:money(q.deliveryFeeMinor),
    totalMinor:money(q.totalMinor),merchantCommissionMinor:money(q.merchantCommissionMinor),
    merchantPayableMinor:money(q.merchantPayableMinor),driverPayableMinor:money(q.driverPayableMinor),
    platformGrossMinor:money(q.platformGrossMinor),
    lines:input.lines.map(l=>({
      productId:l.productId.toLowerCase(),name:lookup.get(l.productId.toLowerCase())!.name,
      quantity:l.quantity,unitMinor:lookup.get(l.productId.toLowerCase())!.price_minor
    }))};
}
export async function previewCart(pool:Pool,input:CartInput){
  validateCart(input);
  const client=await pool.connect();
  try{const products=await catalog(client,input,false);return buildQuote(input,products);}
  finally{client.release();}
}
export async function findBuyerOrder(pool:Pool,buyerId:string,id:string):Promise<OrderView|null>{
  if(!uuid.test(id))throw new OrderServiceError('ORDER_INVALID');
  const result=await pool.query<DbOrder>(`
    SELECT * FROM tala_core_v2.orders
    WHERE id=$1::uuid AND buyer_id=$2::uuid`,[id,buyerId]);
  if(!result.rows[0])return null;
  return (await loadOrders(pool,[result.rows[0]]))[0]??null;
}
export async function listBuyerOrders(pool:Pool,buyerId:string):Promise<OrderView[]>{
  const result=await pool.query<DbOrder>(`
    SELECT * FROM tala_core_v2.orders WHERE buyer_id=$1::uuid
    ORDER BY created_at DESC,id DESC LIMIT 100`,[buyerId]);
  return loadOrders(pool,result.rows);
}
export async function listMerchantOrders(pool:Pool,memberId:string):Promise<OrderView[]>{
  const result=await pool.query<DbOrder>(`
    SELECT o.* FROM tala_core_v2.orders o
    JOIN tala_core_v2.restaurant_memberships m ON m.restaurant_id=o.restaurant_id
    WHERE m.member_id=$1::uuid AND m.is_active=true
    ORDER BY o.created_at DESC,o.id DESC LIMIT 100`,[memberId]);
  return loadOrders(pool,result.rows);
}
type DbLine={order_id:string;product_name_snapshot:string;quantity:number;unit_minor:string};
async function loadOrders(client:Pick<Pool,'query'>,rows:DbOrder[]):Promise<OrderView[]>{
  if(!rows.length)return [];
  // One batched query instead of one DB request per order (N+1).
  const result=await client.query<DbLine>(`
    SELECT order_id,product_name_snapshot,quantity,unit_minor
    FROM tala_core_v2.order_lines
    WHERE order_id=ANY($1::uuid[])
    ORDER BY order_id,line_number`,[rows.map(row=>row.id)]);
  const linesByOrder=new Map<string,OrderView['lines']>();
  for(const line of result.rows){
    const group=linesByOrder.get(line.order_id)??[];
    group.push({name:line.product_name_snapshot,quantity:line.quantity,unitMinor:line.unit_minor});
    linesByOrder.set(line.order_id,group);
  }
  return rows.map(row=>({
    id:row.id,restaurantId:row.restaurant_id,buyerId:row.buyer_id,
    status:row.status,fulfillment:row.fulfillment,paymentMethod:row.payment_method,
    paymentStatus:row.payment_status,totalMinor:row.total_minor,version:row.version,
    deliveryAddress:row.delivery_address,
    createdAt:new Date(row.created_at).toISOString(),
    lines:linesByOrder.get(row.id)??[]
  }));
}
async function loadOrder(client:Pick<Pool,'query'>,row:DbOrder):Promise<OrderView>{
  return (await loadOrders(client,[row]))[0]!;
}
export async function createCashOrder(pool:Pool,buyerId:string,input:CreateInput):Promise<{order:OrderView;replayed:boolean}>{
  validateCart(input);
  if(input.paymentMethod!=='cash'||typeof input.idempotencyKey!=='string'
    ||!/^[a-zA-Z0-9_.:-]{16,128}$/.test(input.idempotencyKey))
    throw new OrderServiceError('CHECKOUT_INVALID');
  const requestHash=checkoutHash(input);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    // Bound lock waits and queries; never leave a checkout/cancellation hanging.
    // SET LOCAL is automatically rolled back or reset at COMMIT.
    await client.query("SET LOCAL lock_timeout = '3000ms'");
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15000ms'");
    // Serialize requests from the same buyer BEFORE reading idempotency state.
    const buyer=await client.query('SELECT id FROM tala_core_v2.accounts WHERE id=$1::uuid AND is_active=true AND role=\'customer\' FOR UPDATE',[buyerId]);
    if(!buyer.rows[0])throw new OrderServiceError('BUYER_NOT_AUTHORIZED');
    const previous=await client.query<DbOrder>(`
      SELECT * FROM tala_core_v2.orders WHERE buyer_id=$1::uuid AND idempotency_key=$2
      FOR UPDATE`,[buyerId,input.idempotencyKey]);
    if(previous.rows[0]){
      const hash=await client.query<{request_hash:string}>('SELECT request_hash FROM tala_core_v2.orders WHERE id=$1::uuid',[previous.rows[0].id]);
      if(hash.rows[0]?.request_hash!==requestHash)throw new OrderServiceError('IDEMPOTENCY_CONFLICT');
      const found=await loadOrder(client,previous.rows[0]);
      await client.query('COMMIT');return {order:found,replayed:true};
    }
    const products=await catalog(client,input,true);
    const quote=buildQuote(input,products);
    // Stock changes, order, line snapshots, event and outbox share one COMMIT.
    for(const line of input.lines){
      const result=await client.query(`
        UPDATE tala_core_v2.catalog_products SET stock=stock-$2,updated_at=now()
        WHERE id=$1::uuid AND stock>=$2 RETURNING id`,[line.productId,line.quantity]);
      if(result.rowCount!==1)throw new OrderServiceError('OUT_OF_STOCK');
    }
    const snapshot={...quote,lines:quote.lines};
    const created=await client.query<DbOrder>(`
      INSERT INTO tala_core_v2.orders(buyer_id,restaurant_id,fulfillment,status,
        payment_method,payment_status,total_minor,pricing_policy_version,
        price_snapshot,idempotency_key,request_hash,delivery_address)
      VALUES($1::uuid,$2::uuid,$3,'received','cash','pending',$4,$5,$6::jsonb,
        $7,$8,$9) RETURNING *`,[
          buyerId,input.restaurantId,input.fulfillment,quote.totalMinor,quote.policyVersion,
          JSON.stringify(snapshot),input.idempotencyKey,requestHash,input.fulfillment==='delivery'?input.deliveryAddress!.trim():null
        ]);
    const order=created.rows[0]!;
    for(let i=0;i<input.lines.length;i++){
      const line=quote.lines[i]!;
      await client.query(`
        INSERT INTO tala_core_v2.order_lines
          (order_id,line_number,product_id,product_name_snapshot,unit_minor,quantity)
        VALUES($1::uuid,$2,$3::uuid,$4,$5,$6)`,
        [order.id,i+1,line.productId,line.name,line.unitMinor,line.quantity]);
    }
    const eventKey=createHash('sha256').update('order.received|'+order.id).digest('hex');
    await client.query(`
      INSERT INTO tala_core_v2.order_events
        (order_id,event_key,previous_status,new_status,actor_role,actor_id,data)
      VALUES($1::uuid,$2,NULL,'received','system',NULL,'{}'::jsonb)`,[order.id,eventKey]);
    await client.query(`
      INSERT INTO tala_core_v2.outbox(aggregate_id,event_key,event_type,payload)
      VALUES($1::uuid,$2,'order.created',$3::jsonb)`,
      [order.id,eventKey,JSON.stringify({orderId:order.id,restaurantId:input.restaurantId,status:'received'})]);
    const view=await loadOrder(client,order);
    await client.query('COMMIT');return {order:view,replayed:false};
  }catch(err){await client.query('ROLLBACK');throw err;}
  finally{client.release();}
}
