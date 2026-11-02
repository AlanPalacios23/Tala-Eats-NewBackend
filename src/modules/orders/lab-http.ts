/**
 * Isolated HTTP LAB API. Imports real transactional services and DB auth.
 * No Stripe, payouts, external API or LIVE integration.
 */
import express from 'express';
import type {Request,Response,NextFunction} from 'express';
import type {Pool} from 'pg';
import {z} from 'zod';
import {hashPassword,verifyPassword,issueSession,resolveSession,getSessionToken,
  tokenHash,sessionCookie,clearedSessionCookie} from './lab-auth.ts';
import type {Identity} from './lab-auth.ts';
import {OrderServiceError,previewCart,createCashOrder,listBuyerOrders,
  findBuyerOrder,findMerchantOrder,listMerchantOrders} from './checkout.ts';
import {readOrderTimeline,readBuyerReceipt} from './orders-read.ts';
import {cancelCashOrder} from './cancel.ts';
import {advanceMerchantOrder,MerchantOrderError} from './merchant-orders.ts';
import {claimDelivery,advanceDelivery,availableDriverOrders,myDriverOrders,
  issueBuyerHandoffPin,attestCash,finishCashOrder} from './handoff.ts';
import {LogisticsError,getDriverLogistics,changeDriverPresence,recordDriverLocation}
  from '../logistics/driver-operations.ts';
import {DispatchError,listDriverDispatchOffers,acceptDispatchOffer,declineDispatchOffer}
  from '../logistics/tala-dispatch-engine.ts';

type Handler=(req:Request,res:Response)=>Promise<void>;
const wrap=(fn:Handler)=>(req:Request,res:Response,next:NextFunction)=>{
  Promise.resolve().then(()=>fn(req,res)).catch(next);
};
class AuthError extends Error{readonly code:string;constructor(code:string){super(code);this.code=code;}}
const uuid=z.string().uuid();
const lines=z.array(z.object({
  productId:uuid,quantity:z.number().int().min(1).max(100)
}).strict()).min(1).max(50);
const cart=z.object({
  restaurantId:uuid,fulfillment:z.enum(['pickup','delivery']),
  // Empty address is valid for pickup; delivery is validated by validateCart.
  lines,deliveryAddress:z.string().max(240).optional()
}).strict();
const checkout=cart.extend({
  paymentMethod:z.literal('cash'),
  idempotencyKey:z.string().regex(/^[a-zA-Z0-9_.:-]{16,128}$/)
}).strict();
const command=z.object({
  expectedVersion:z.string().regex(/^[1-9]\d{0,15}$/),
  commandKey:z.string().regex(/^[a-zA-Z0-9_.:-]{16,128}$/)
}).strict();
const stateCommand=command.extend({
  status:z.enum(['confirmed','preparing','ready'])
}).strict();
const driverState=command.extend({
  status:z.enum(['picked_up','on_the_way'])
}).strict();
const presenceCommand=command.extend({online:z.boolean()}).strict();
const locationCommand=z.object({
  latitude:z.number().finite().min(-90).max(90),
  longitude:z.number().finite().min(-180).max(180),
  accuracyMeters:z.number().int().min(1).max(100),
  sequence:z.string().regex(/^[1-9]\d{0,18}$/),
  observedAt:z.string().datetime({offset:true})
}).strict();
const finishCommand=command.extend({pin:z.string().regex(/^\d{8}$/)}).strict();
const noInput=z.object({}).strict();
const signup=z.object({
  email:z.string().email().max(254).transform(s=>s.toLowerCase().trim()),
  password:z.string().min(12).max(128),
  displayName:z.string().min(2).max(100)
}).strict();
const signin=z.object({email:z.string().email(),password:z.string()}).strict();
const cookies=(req:Request)=>getSessionToken(req.headers.cookie);
async function requireAuth(pool:Pool,req:Request,role?:'customer'|'merchant'|'driver'):Promise<Identity>{
  const identity=await resolveSession(pool,cookies(req));
  if(!identity)throw new AuthError('AUTH_REQUIRED');
  if(role&&identity.role!==role)throw new AuthError('ROLE_FORBIDDEN');
  return identity;
}
function parse<T>(schema:z.ZodType<T>,body:unknown):T{
  const result=schema.safeParse(body);
  if(!result.success)throw new OrderServiceError('REQUEST_INVALID');
  return result.data;
}
const statusOf=(error:Error):number=>{
  const transport=error as Error&{status?:number;type?:string;code?:string};
  if(transport.status===400&&transport.type==='entity.parse.failed')return 400;
  if(transport.status===413&&transport.type==='entity.too.large')return 413;
  if(['55P03','57014','40P01','40001'].includes(transport.code??''))return 503;
  if(error instanceof AuthError)return ['AUTH_REQUIRED','INVALID_CREDENTIALS'].includes(error.code)?401:403;
  if(error instanceof z.ZodError)return 400;
  if(error instanceof DispatchError){
    if(error.code.endsWith('_INVALID'))return 400;
    if(error.code.endsWith('_NOT_FOUND'))return 404;
    return 409;
  }
  if(error instanceof LogisticsError){
    if(error.code==='LOCATION_RATE_LIMITED')return 429;
    if(error.code==='DRIVER_NOT_AVAILABLE')return 403;
    if(error.code.endsWith('_INVALID'))return 400;
    return 409;
  }
  if(error instanceof OrderServiceError||error instanceof MerchantOrderError){
    const code=error.code;
    if(code==='CART_TOTAL_OUT_OF_RANGE')return 400;
    if(code==='PIN_GENERATION_RATE_LIMITED')return 429;
    if(code==='PIN_INVALID')return 409; // correct PIN format, wrong proof
    if(code.includes('NOT_FOUND'))return 404;
    if(code.includes('NOT_AUTHORIZED'))return 403;
    if(code.includes('INVALID')||code==='ADDRESS_REQUIRED'||code==='PICKUP_HAS_NO_ADDRESS')
      return 400;
    return 409;
  }
  return 500;
};
export function createOrderApp(pool:Pool){
  const app=express();
  app.disable('x-powered-by');
  // Limited LAB-process throttling, not a substitute for shared/distributed
  // rate limits and bot protection before commercial launch.
  const attempts=new Map<string,{count:number;expires:number}>();
  const attemptWindowMs=60_000;
  function limitAuth(req:Request,res:Response,next:NextFunction){
    const now=Date.now();
    // Never use untrusted X-Forwarded-For: trust proxy stays disabled.
    const source=req.socket.remoteAddress??'unknown';
    const route=req.path;
    const key=route+'|'+source;
    let current=attempts.get(key);
    if(!current||current.expires<=now)current={count:0,expires:now+attemptWindowMs};
    if(current.count >= (route.endsWith('/login')?12:6)){
      res.setHeader('Retry-After',String(Math.max(1,Math.ceil((current.expires-now)/1000))));
      res.status(429).json({code:'AUTH_RATE_LIMITED'});return;
    }
    current.count++;
    if(attempts.size>=1024){
      for(const [stored,value] of attempts){if(value.expires<=now)attempts.delete(stored);}
      if(attempts.size>=1024)attempts.delete(attempts.keys().next().value!);
    }
    attempts.set(key,current);
    next();
  }
  app.use((_,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    next();
  });
  app.use(express.json({limit:'20kb'}));
  app.use((req,res,next)=>{
    // All mutations are JSON, explicitly same-origin and carry a CSRF guard.
    if(['POST','PUT','PATCH','DELETE'].includes(req.method)){
      const origin=req.get('origin');
      const fetchSite=req.get('sec-fetch-site');
      if((origin&&origin!==req.protocol+'://'+req.get('host'))||
        (fetchSite&&!['same-origin','none'].includes(fetchSite))){
        res.status(403).json({code:'ORIGIN_FORBIDDEN'});return;
      }
      if(req.get('X-Talaeats-Client')!=='core-v2-lab'){
        res.status(403).json({code:'CLIENT_HEADER_REQUIRED'});return;
      }
      if(!req.is('application/json')){
        res.status(415).json({code:'JSON_REQUIRED'});return;
      }
    }
    next();
  });
  app.get('/api/v2/health',(_req,res)=>res.json({
    service:'tala-eats-core-v2',mode:'isolated-lab',commercialReady:false
  }));
  app.get('/api/v2/restaurants',wrap(async(_req,res)=>{
    const stores=await pool.query(`
      SELECT id,name,is_open FROM tala_core_v2.restaurants
      WHERE is_open=true ORDER BY name LIMIT 100`);
    res.json(stores.rows);
  }));
  app.get('/api/v2/restaurants/:id/menu',wrap(async(req,res)=>{
    const id=uuid.parse(req.params.id);
    const products=await pool.query(`
      SELECT p.id,p.name,p.price_minor,p.stock,p.is_available
      FROM tala_core_v2.catalog_products p
      JOIN tala_core_v2.restaurants r ON r.id=p.restaurant_id
      WHERE p.restaurant_id=$1::uuid AND p.is_available=true AND r.is_open=true
      ORDER BY p.name LIMIT 200`,[id]);
    res.json(products.rows);
  }));
  app.post('/api/v2/auth/register',limitAuth,wrap(async(req,res)=>{
    const data=parse(signup,req.body);
    const digest=await hashPassword(data.password);
    try {
      const {rows}=await pool.query<{id:string}>(`
        INSERT INTO tala_core_v2.accounts(email,display_name,password_hash,role)
        VALUES($1,$2,$3,'customer') RETURNING id`,
        [data.email,data.displayName,digest]);
      res.status(201).json({id:rows[0]!.id,role:'customer'});
    }catch(error){
      if((error as {code?:string}).code==='23505')
        throw new OrderServiceError('EMAIL_ALREADY_EXISTS');
      throw error;
    }
  }));
  app.post('/api/v2/auth/login',limitAuth,wrap(async(req,res)=>{
    const {email,password}=parse(signin,req.body);
    const {rows}=await pool.query<{id:string;password_hash:string}>(`
      SELECT id,password_hash FROM tala_core_v2.accounts
      WHERE email=$1 AND is_active=true`,[email.trim().toLowerCase()]);
    const account=rows[0];
    if(!account||!await verifyPassword(password,account.password_hash))
      throw new AuthError('INVALID_CREDENTIALS');
    const token=await issueSession(pool,account.id);
    res.setHeader('Set-Cookie',sessionCookie(token,req.secure));
    res.json({authenticated:true});
  }));
  app.post('/api/v2/auth/logout',wrap(async(req,res)=>{
    const token=cookies(req);
    if(token)await pool.query('DELETE FROM tala_core_v2.sessions WHERE token_hash=$1',[tokenHash(token)]);
    res.setHeader('Set-Cookie',clearedSessionCookie(req.secure));
    res.json({authenticated:false});
  }));
  app.get('/api/v2/auth/me',wrap(async(req,res)=>{
    const identity=await requireAuth(pool,req);
    res.json(identity);
  }));
  app.post('/api/v2/orders/quote',wrap(async(req,res)=>{
    await requireAuth(pool,req,'customer');
    res.json(await previewCart(pool,parse(cart,req.body)));
  }));
  app.post('/api/v2/orders',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'customer');
    const result=await createCashOrder(pool,user.id,parse(checkout,req.body));
    res.status(result.replayed?200:201).json(result);
  }));
  app.get('/api/v2/orders/mine',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'customer');
    res.json(await listBuyerOrders(pool,user.id));
  }));
  app.get('/api/v2/orders/:id',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'customer');
    const order=await findBuyerOrder(pool,user.id,uuid.parse(req.params.id));
    if(!order)throw new OrderServiceError('ORDER_NOT_FOUND');
    res.json(order);
  }));
  app.get('/api/v2/orders/:id/timeline',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'customer');
    res.json(await readOrderTimeline(pool,user.id,'customer',uuid.parse(req.params.id)));
  }));
  app.get('/api/v2/orders/:id/receipt',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'customer');
    res.json(await readBuyerReceipt(pool,user.id,uuid.parse(req.params.id)));
  }));
  app.post('/api/v2/orders/:id/cancel',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'customer');
    const cmd=parse(command,req.body);
    const orderId=uuid.parse(req.params.id);
    const result=await cancelCashOrder(pool,{...cmd,expectedVersion:BigInt(cmd.expectedVersion),
      actor:'customer',actorId:user.id,orderId});
    res.json({...result,version:result.version.toString()});
  }));
  app.get('/api/v2/merchant/orders',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'merchant');
    res.json(await listMerchantOrders(pool,user.id));
  }));
  app.get('/api/v2/merchant/orders/:id',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'merchant');
    const order=await findMerchantOrder(pool,user.id,uuid.parse(req.params.id));
    if(!order)throw new OrderServiceError('ORDER_NOT_FOUND');
    res.json(order);
  }));
  app.get('/api/v2/merchant/orders/:id/timeline',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'merchant');
    res.json(await readOrderTimeline(pool,user.id,'merchant',uuid.parse(req.params.id)));
  }));
  app.patch('/api/v2/merchant/orders/:id/status',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'merchant');
    const cmd=parse(stateCommand,req.body);
    const orderId=uuid.parse(req.params.id);
    const result=await advanceMerchantOrder(pool,{
      orderId,actorId:user.id,target:cmd.status,
      commandKey:cmd.commandKey,expectedVersion:BigInt(cmd.expectedVersion)
    });
    res.json({...result,version:result.version.toString()});
  }));
  app.post('/api/v2/merchant/orders/:id/cancel',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'merchant');
    const cmd=parse(command,req.body);
    const orderId=uuid.parse(req.params.id);
    const result=await cancelCashOrder(pool,{...cmd,expectedVersion:BigInt(cmd.expectedVersion),
      actor:'merchant',actorId:user.id,orderId});
    res.json({...result,version:result.version.toString()});
  }));

  // LAB handoff: PIN is returned only to the authenticated order buyer.
  app.post('/api/v2/orders/:id/handoff-pin',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'customer');
    parse(noInput,req.body);
    const result=await issueBuyerHandoffPin(pool,user.id,uuid.parse(req.params.id));
    res.json(result);
  }));
  app.post('/api/v2/orders/:id/cash-paid',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'customer');
    parse(noInput,req.body);
    res.json(await attestCash(pool,uuid.parse(req.params.id),user.id,'customer'));
  }));
  app.post('/api/v2/merchant/orders/:id/cash-received',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'merchant');
    parse(noInput,req.body);
    res.json(await attestCash(pool,uuid.parse(req.params.id),user.id,'merchant'));
  }));
  app.post('/api/v2/merchant/orders/:id/complete',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'merchant');
    const data=parse(finishCommand,req.body);
    const result=await finishCashOrder(pool,{
      orderId:uuid.parse(req.params.id),actorId:user.id,
      commandKey:data.commandKey,expectedVersion:BigInt(data.expectedVersion)
    },'merchant',data.pin);
    res.json({...result,version:result.version.toString()});
  }));
  // Driver accounts are created only by a trusted lab bootstrap and require
  // approved, online profiles to claim orders. No public role promotion.
  // Logistics LAB endpoints are mounted ONLY under the existing localhost
  // write gate. They do not exist on public Render staging or Kali.
  app.get('/api/v2/driver/logistics',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'driver');
    res.json(await getDriverLogistics(pool,user.id));
  }));
  app.post('/api/v2/driver/presence',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'driver');
    const data=parse(presenceCommand,req.body);
    res.json(await changeDriverPresence(pool,user.id,{
      online:data.online,expectedVersion:BigInt(data.expectedVersion),
      commandKey:data.commandKey
    }));
  }));
  app.post('/api/v2/driver/location',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'driver');
    const data=parse(locationCommand,req.body);
    res.json(await recordDriverLocation(pool,user.id,{
      latitude:data.latitude,longitude:data.longitude,
      accuracyMeters:data.accuracyMeters,sequence:BigInt(data.sequence),
      observedAt:data.observedAt
    }));
  }));
  app.get('/api/v2/driver/dispatch-offers',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'driver');
    res.json(await listDriverDispatchOffers(pool,user.id));
  }));
  app.post('/api/v2/driver/dispatch-offers/:offerId/accept',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'driver');
    parse(noInput,req.body);
    res.json(await acceptDispatchOffer(pool,user.id,uuid.parse(req.params.offerId)));
  }));
  app.post('/api/v2/driver/dispatch-offers/:offerId/decline',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'driver');
    parse(noInput,req.body);
    res.json(await declineDispatchOffer(pool,user.id,uuid.parse(req.params.offerId)));
  }));
  app.get('/api/v2/driver/available',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'driver');
    res.json(await availableDriverOrders(pool,user.id));
  }));
  app.get('/api/v2/driver/orders',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'driver');
    res.json(await myDriverOrders(pool,user.id));
  }));
  app.get('/api/v2/driver/orders/:id/timeline',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'driver');
    res.json(await readOrderTimeline(pool,user.id,'driver',uuid.parse(req.params.id)));
  }));
  app.post('/api/v2/driver/orders/:id/claim',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'driver');
    const cmd=parse(command,req.body);
    const result=await claimDelivery(pool,{
      orderId:uuid.parse(req.params.id),actorId:user.id,
      commandKey:cmd.commandKey,expectedVersion:BigInt(cmd.expectedVersion)
    });
    res.json({...result,version:result.version.toString()});
  }));
  app.patch('/api/v2/driver/orders/:id/status',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'driver');
    const cmd=parse(driverState,req.body);
    const result=await advanceDelivery(pool,{
      orderId:uuid.parse(req.params.id),actorId:user.id,
      commandKey:cmd.commandKey,expectedVersion:BigInt(cmd.expectedVersion)
    },cmd.status);
    res.json({...result,version:result.version.toString()});
  }));
  app.post('/api/v2/driver/orders/:id/cash-received',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'driver');
    parse(noInput,req.body);
    res.json(await attestCash(pool,uuid.parse(req.params.id),user.id,'driver'));
  }));
  app.post('/api/v2/driver/orders/:id/complete',wrap(async(req,res)=>{
    const user=await requireAuth(pool,req,'driver');
    const data=parse(finishCommand,req.body);
    const result=await finishCashOrder(pool,{
      orderId:uuid.parse(req.params.id),actorId:user.id,
      commandKey:data.commandKey,expectedVersion:BigInt(data.expectedVersion)
    },'driver',data.pin);
    res.json({...result,version:result.version.toString()});
  }));
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    const err=error instanceof Error?error:new Error('UNKNOWN_ERROR');
    const status=statusOf(err);
    // Never return raw SQL/stack traces or customer details.
    if(status===503)res.setHeader('Retry-After','2');
    if(status===429&&err instanceof LogisticsError)res.setHeader('Retry-After','2');
    if(status===429&&err instanceof OrderServiceError&&
      err.code==='PIN_GENERATION_RATE_LIMITED')res.setHeader('Retry-After','600');
    res.status(status).json({code:status===500?'INTERNAL_ERROR':
      status===503?'ORDER_TEMPORARILY_BUSY':
      status===413?'BODY_TOO_LARGE':
      err instanceof AuthError||err instanceof OrderServiceError||err instanceof MerchantOrderError||err instanceof LogisticsError||err instanceof DispatchError
        ?err.code:'REQUEST_INVALID'});
  });
  return app;
}
