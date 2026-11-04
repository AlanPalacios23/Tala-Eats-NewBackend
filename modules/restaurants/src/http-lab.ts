/** LAB-only HTTP adapter: host-injected identity; no public deployment.
 * HTTP callers never declare their owner/role; every mutation checks RBAC.
 */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {Pool} from 'pg';
import {RestaurantError,uuid,person,assertKeys,type Actor} from './domain.js';
import {createStore,readStore,listMyStores,updateStore,changeStoreStatus,
 setStaffRole,createBranch,setBranchHours,setBranchActive,listBranches} from './stores.js';
import {createProduct,updateProduct,archiveProduct,createVariant,setVariantPrice,
 adjustStock,readCatalog} from './catalog.js';
import {prepareProductPhoto,listProductPhotos,selectPrimaryPhoto} from './media.js';
import {scheduleBranchClosure,cancelBranchClosure,listBranchClosures} from './closures.js';
import {setBranchVariantEnabled,readBranchStorefront} from './branch-catalog.js';
import {retireProductPhoto} from './media.js';
import {readMerchantOverview} from './overview.js';
import {enableBranchInventory,adjustBranchStock,readBranchStock} from './branch-stock.js';
import {transferBranchStock,countBranchStock,readBranchInventoryActivity} from './inventory-operations.js';
import {discoverReadyBranches} from './discovery.js';

type Identity=Actor;
type Config={pool:Pool,authenticate:(req:IncomingMessage)=>Promise<Identity|null>};
const BODY_MAX=16384;
function reply(res:ServerResponse,status:number,value:unknown){
  if(res.headersSent)return;
  const valueJson=JSON.stringify(value);
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Content-Length':Buffer.byteLength(valueJson),
    'Cache-Control':'private, no-store',
    'X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'none'",
    'Referrer-Policy':'no-referrer'
  });
  res.end(valueJson);
}
async function body(req:IncomingMessage,fields:readonly string[]){
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
    req.headers['content-type']??''))
    throw new RestaurantError('M6_CONTENT_TYPE_REQUIRED');
  const len=Number(req.headers['content-length']??0);
  if(!Number.isSafeInteger(len)||len<0||len>BODY_MAX)
    throw new RestaurantError('M6_BODY_TOO_LARGE');
  const chunks:Buffer[]=[];let bytes=0;
  for await(const piece of req){
    const b=Buffer.isBuffer(piece)?piece:Buffer.from(piece);
    bytes+=b.length;
    if(bytes>BODY_MAX)throw new RestaurantError('M6_BODY_TOO_LARGE');
    chunks.push(b);
  }
  let decoded:unknown;
  try{decoded=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw new RestaurantError('M6_REQUEST_INVALID');}
  assertKeys(decoded,fields);
  return decoded as Record<string,unknown>;
}
function pathId(v:string|undefined){
  return uuid(v);
}
export function createRestaurantsLabHttpServer({pool,authenticate}:Config){
  if(process.env.NODE_ENV==='production'||typeof authenticate!=='function')
    throw new RestaurantError('M6_LAB_HTTP_DISABLED');
  return createServer(async(req,res)=>{
    if(req.socket.localAddress!=='127.0.0.1'&&req.socket.localAddress!=='::1'){
      reply(res,403,{error:'M6_LOOPBACK_ONLY'});return;
    }
    let url:URL;
    try{url=new URL(req.url??'/', 'http://127.0.0.1');}
    catch{reply(res,400,{error:'M6_REQUEST_INVALID'});return;}
    const method=req.method??'',parts=url.pathname.split('/').filter(Boolean);
    try{
      if(url.pathname==='/v1/restaurants/health'&&method==='GET'){
        reply(res,200,{module:'restaurants',status:'lab_ready'});return;
      }
      const who=await authenticate(req);
      if(!who)throw new RestaurantError('M6_UNAUTHORIZED');
      const actor={actorId:person(who)};
      if(parts[0]!=='v1'||parts[1]!=='restaurants'){
        reply(res,404,{error:'M6_ROUTE_NOT_FOUND'});return;
      }
      const p=parts.slice(2);
      if(p.length===0&&method==='POST'){
        const data=await body(req,['operationId','slug','name','kind','description']);
        reply(res,201,await createStore(pool,actor,data as never));return;
      }
      if(p.length===0&&method==='GET'){
        reply(res,200,{stores:await listMyStores(pool,actor)});return;
      }
      if(p.length===1&&p[0]==='discover'&&method==='GET'){
        const keys=[...url.searchParams.keys()];
        if(keys.some(k=>!['city','kind','search','limit','offset'].includes(k))||
           new Set(keys).size!==keys.length)
          throw new RestaurantError('M6_PAGE_INVALID');
        const city=url.searchParams.get('city');
        if(city===null)throw new RestaurantError('M6_CITY_INVALID');
        const kind=url.searchParams.get('kind'),search=url.searchParams.get('search'),
          limit=url.searchParams.get('limit'),offset=url.searchParams.get('offset');
        reply(res,200,await discoverReadyBranches(pool,{
          city:city as never,
          ...(kind===null?{}:{kind:kind as never}),
          ...(search===null?{}:{search}),
          ...(limit===null?{}:{limit:Number(limit)}),
          ...(offset===null?{}:{offset:Number(offset)})
        }));return;
      }
      const storeId=pathId(p[0]);
      if(p.length===1&&method==='GET'){
        reply(res,200,await readStore(pool,actor,storeId));return;
      }
      if(p.length===1&&method==='PATCH'){
        const data=await body(req,['expectedVersion','name','description']);
        reply(res,200,await updateStore(pool,actor,{...data,storeId} as never));return;
      }
      if(p.length===2&&p[1]==='overview'&&method==='GET'){
        reply(res,200,await readMerchantOverview(pool,actor,storeId));return;
      }
      if(p.length===2&&p[1]==='status'&&method==='POST'){
        const data=await body(req,['expectedVersion','status']);
        reply(res,200,await changeStoreStatus(pool,actor,{...data,storeId} as never));
        return;
      }
      if(p.length===2&&p[1]==='staff'&&method==='PUT'){
        const data=await body(req,['memberId','role']);
        reply(res,200,await setStaffRole(pool,actor,{...data,storeId} as never));return;
      }
      if(p.length===2&&p[1]==='branches'&&method==='GET'){
        reply(res,200,await listBranches(pool,actor,storeId));return;
      }
      if(p.length===2&&p[1]==='branches'&&method==='POST'){
        const data=await body(req,['operationId','name','address','city',
          'pickupEnabled','deliveryEnabled','latitude','longitude']);
        reply(res,201,await createBranch(pool,actor,{...data,storeId} as never));return;
      }
      if(p.length===4&&p[1]==='branches'&&p[3]==='closures'&&method==='GET'){
        reply(res,200,await listBranchClosures(pool,actor,{
          storeId,branchId:pathId(p[2])
        }));return;
      }
      if(p.length===4&&p[1]==='branches'&&p[3]==='closures'&&method==='POST'){
        const data=await body(req,['operationId','startsAt','endsAt','reason']);
        reply(res,201,await scheduleBranchClosure(pool,actor,{
          ...data,storeId,branchId:pathId(p[2])
        } as never));return;
      }
      if(p.length===6&&p[1]==='branches'&&p[3]==='closures'&&
         p[5]==='cancel'&&method==='POST'){
        await body(req,[]);
        reply(res,200,await cancelBranchClosure(pool,actor,{
          storeId,branchId:pathId(p[2]),closureId:pathId(p[4])
        }));return;
      }
      if(p.length===4&&p[1]==='branches'&&p[3]==='storefront'&&method==='GET'){
        const query=[...url.searchParams.keys()];
        if(query.some(key=>!['limit','offset','category'].includes(key))||
           new Set(query).size!==query.length)
          throw new RestaurantError('M6_PAGE_INVALID');
        const count=url.searchParams.get('limit'),skip=url.searchParams.get('offset'),
          category=url.searchParams.get('category');
        reply(res,200,await readBranchStorefront(pool,{
          storeId,branchId:pathId(p[2]),
          ...(count===null?{}:{limit:Number(count)}),
          ...(skip===null?{}:{offset:Number(skip)}),
          ...(category===null?{}:{category})
        }));return;
      }
      if(p.length===6&&p[1]==='branches'&&p[3]==='variants'&&
         p[5]==='enabled'&&method==='PUT'){
        const data=await body(req,['expectedVersion','enabled']);
        reply(res,200,await setBranchVariantEnabled(pool,actor,{
          ...data,storeId,branchId:pathId(p[2]),variantId:pathId(p[4])
        } as never));return;
      }
      if(p.length===3&&p[1]==='stock'&&p[2]==='transfers'&&method==='POST'){
        const data=await body(req,['operationId','fromBranchId','toBranchId',
          'variantId','quantity']);
        reply(res,200,await transferBranchStock(pool,actor,{
          ...data,storeId
        } as never));return;
      }
      if(p.length===4&&p[1]==='branches'&&p[3]==='stock'&&method==='GET'){
        reply(res,200,await readBranchStock(pool,actor,{
          storeId,branchId:pathId(p[2])
        }));return;
      }
      if(p.length===5&&p[1]==='branches'&&p[3]==='stock'&&
         p[4]==='activity'&&method==='GET'){
        const keys=[...url.searchParams.keys()];
        if(keys.some(key=>key!=='limit')||new Set(keys).size!==keys.length)
          throw new RestaurantError('M6_PAGE_INVALID');
        const limit=url.searchParams.get('limit');
        reply(res,200,await readBranchInventoryActivity(pool,actor,{
          storeId,branchId:pathId(p[2]),...(limit===null?{}:{limit:Number(limit)})
        }));return;
      }
      if(p.length===6&&p[1]==='branches'&&p[3]==='variants'&&
         p[5]==='count'&&method==='POST'){
        const data=await body(req,['operationId','expectedVersion','countedQuantity']);
        reply(res,200,await countBranchStock(pool,actor,{
          ...data,storeId,branchId:pathId(p[2]),variantId:pathId(p[4])
        } as never));return;
      }
      if(p.length===6&&p[1]==='branches'&&p[3]==='variants'&&
         p[5]==='stock'&&method==='POST'){
        const data=await body(req,['operationId','delta','reason']);
        reply(res,200,await adjustBranchStock(pool,actor,{
          ...data,storeId,branchId:pathId(p[2]),variantId:pathId(p[4])
        } as never));return;
      }
      if(p.length===4&&p[1]==='branches'&&p[3]==='hours'&&method==='PUT'){
        const data=await body(req,['expectedVersion','days']);
        reply(res,200,await setBranchHours(pool,actor,{
          ...data,storeId,branchId:pathId(p[2])
        } as never));return;
      }
      if(p.length===4&&p[1]==='branches'&&p[3]==='active'&&method==='PUT'){
        const data=await body(req,['expectedVersion','active']);
        reply(res,200,await setBranchActive(pool,actor,{
          ...data,storeId,branchId:pathId(p[2])
        } as never));return;
      }
      if(p.length===2&&p[1]==='catalog'&&method==='GET'){
        reply(res,200,await readCatalog(pool,actor,storeId));return;
      }
      if(p.length===2&&p[1]==='products'&&method==='POST'){
        const data=await body(req,['operationId','name','description','category']);
        reply(res,201,await createProduct(pool,actor,{...data,storeId} as never));
        return;
      }
      if(p.length===3&&p[1]==='products'&&method==='PATCH'){
        const data=await body(req,['expectedVersion','name','description',
          'category','isActive']);
        reply(res,200,await updateProduct(pool,actor,{
          ...data,storeId,productId:pathId(p[2])
        } as never));return;
      }
      if(p.length===4&&p[1]==='products'&&p[3]==='archive'&&method==='POST'){
        const data=await body(req,['expectedVersion']);
        reply(res,200,await archiveProduct(pool,actor,{
          ...data,storeId,productId:pathId(p[2])
        } as never));return;
      }
      if(p.length===4&&p[1]==='products'&&p[3]==='variants'&&method==='POST'){
        const data=await body(req,['operationId','label','priceCents',
          'weightGrams','stockQuantity','trackStock']);
        reply(res,201,await createVariant(pool,actor,{
          ...data,storeId,productId:pathId(p[2])
        } as never));return;
      }
      if(p.length===4&&p[1]==='variants'&&p[3]==='branch-inventory'&&method==='POST'){
        const data=await body(req,['expectedVersion']);
        reply(res,200,await enableBranchInventory(pool,actor,{
          ...data,storeId,variantId:pathId(p[2])
        } as never));return;
      }
      if(p.length===4&&p[1]==='variants'&&p[3]==='price'&&method==='PUT'){
        const data=await body(req,['expectedVersion','priceCents']);
        reply(res,200,await setVariantPrice(pool,actor,{
          ...data,storeId,variantId:pathId(p[2])
        } as never));return;
      }
      if(p.length===4&&p[1]==='variants'&&p[3]==='stock'&&method==='POST'){
        const data=await body(req,['operationId','delta','reason']);
        reply(res,200,await adjustStock(pool,actor,{
          ...data,storeId,variantId:pathId(p[2])
        } as never));return;
      }
      if(p.length===4&&p[1]==='products'&&p[3]==='photos'&&method==='GET'){
        reply(res,200,{photos:await listProductPhotos(pool,actor,{
          storeId,productId:pathId(p[2])
        })});return;
      }
      if(p.length===4&&p[1]==='products'&&p[3]==='photos'&&method==='POST'){
        const data=await body(req,['sha256','contentType']);
        reply(res,201,await prepareProductPhoto(pool,actor,{
          ...data,storeId,productId:pathId(p[2])
        } as never));return;
      }
      if(p.length===6&&p[1]==='products'&&p[3]==='photos'&&
         p[5]==='retire'&&method==='POST'){
        await body(req,[]);
        reply(res,200,await retireProductPhoto(pool,actor,{
          storeId,productId:pathId(p[2]),photoId:pathId(p[4])
        }));return;
      }
      if(p.length===6&&p[1]==='products'&&p[3]==='photos'&&
         p[5]==='primary'&&method==='PUT'){
        await body(req,[]);
        reply(res,200,await selectPrimaryPhoto(pool,actor,{
          storeId,productId:pathId(p[2]),photoId:pathId(p[4])
        }));return;
      }
      reply(res,404,{error:'M6_ROUTE_NOT_FOUND'});
    }catch(e){
      if(e instanceof RestaurantError){
        const status=e.code==='M6_UNAUTHORIZED'?401:
          e.code==='M6_FORBIDDEN'?403:
          e.code==='M6_CONTENT_TYPE_REQUIRED'?415:
          e.code==='M6_BODY_TOO_LARGE'?413:
          ['M6_VERSION_CONFLICT','M6_IDEMPOTENCY_CONFLICT',
           'M6_CLOSURE_OVERLAP','M6_STOCK_CONFLICT',
           'M6_BRANCH_STOCK_SWITCH_CONFLICT'].includes(e.code)?409:400;
        reply(res,status,{error:e.code});return;
      }
      reply(res,500,{error:'M6_INTERNAL_ERROR'});
    }
  });
}
