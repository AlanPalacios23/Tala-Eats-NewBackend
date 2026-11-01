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
  findBuyerOrder,listMerchantOrders} from './checkout.ts';
import {cancelCashOrder} from './cancel.ts';
import {advanceMerchantOrder,MerchantOrderError} from './merchant-orders.ts';

type Handler=(req:Request,res:Response)=>Promise<void>;
const wrap=(fn:Handler)=>(req:Request,res:Response,next:NextFunction)=>{
  Promise.resolve().then(()=>fn(req,res)).catch(next);
};
class AuthError extends Error{constructor(readonly code:string){super(code);}}
const uuid=z.string().uuid();
const lines=z.array(z.object({
  productId:uuid,quantity:z.number().int().min(1).max(100)
}).strict()).min(1).max(50);
const cart=z.object({
  restaurantId:uuid,fulfillment:z.enum(['pickup','delivery']),
  lines,deliveryAddress:z.string().min(5).max(240).optional()
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
const signup=z.object({
  email:z.string().email().max(254).transform(s=>s.toLowerCase().trim()),
  password:z.string().min(12).max(128),
  displayName:z.string().min(2).max(100)
}).strict();
const signin=z.object({email:z.string().email(),password:z.string()}).strict();
const cookies=(req:Request)=>getSessionToken(req.headers.cookie);
async function requireAuth(pool:Pool,req:Request,role?:'customer'|'merchant'):Promise<Identity>{
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
  if(error instanceof AuthError)return error.code==='AUTH_REQUIRED'?401:403;
  if(error instanceof z.ZodError)return 400;
  if(error instanceof OrderServiceError||error instanceof MerchantOrderError){
    const code=error.code;
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
  app.use(express.json({limit:'20kb'}));
  app.use((req,res,next)=>{
    // All mutations are JSON, explicitly same-origin and carry a CSRF guard.
    if(['POST','PUT','PATCH','DELETE'].includes(req.method)){
      const origin=req.get('origin');
      if(origin&&origin!==req.protocol+'://'+req.get('host')){
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
      SELECT id,name,price_minor,stock,is_available FROM tala_core_v2.catalog_products
      WHERE restaurant_id=$1::uuid AND is_available=true ORDER BY name LIMIT 200`,[id]);
    res.json(products.rows);
  }));
  app.post('/api/v2/auth/register',wrap(async(req,res)=>{
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
  app.post('/api/v2/auth/login',wrap(async(req,res)=>{
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
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    const err=error instanceof Error?error:new Error('UNKNOWN_ERROR');
    const status=statusOf(err);
    // Never return raw SQL/stack traces or customer details.
    res.status(status).json({code:status===500?'INTERNAL_ERROR':
      err instanceof AuthError||err instanceof OrderServiceError||err instanceof MerchantOrderError
        ?err.code:'REQUEST_INVALID'});
  });
  return app;
}
