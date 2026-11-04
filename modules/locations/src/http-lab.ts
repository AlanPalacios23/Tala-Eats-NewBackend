/** M7 standalone loopback HTTP LAB adapter. Host authenticates and sets roles.
 * Never deploy this adapter as a public production endpoint.
 */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {Pool} from 'pg';
import {LocationError,uuid,assertKeys,type Actor} from './domain.js';
import {PrivateLocationCipher} from './crypto.js';
import {createZone,updateZone,listZones,checkCoverage} from './zones.js';
import {createPolygonZone,updatePolygonZone,listPolygonZones,
 checkCoverageV2} from './polygon-zones.js';
import {createPlace,listPlaces,updatePlace,setDefaultPlace,deletePlace} from './places.js';
import {putLocationSnapshot,getLocationSnapshot,clearLocationSnapshot} from './snapshots.js';
type Config={pool:Pool,cipher:PrivateLocationCipher,
 authenticate:(request:IncomingMessage)=>Promise<Actor|null>};
const MAX_BODY=8192;
function reply(res:ServerResponse,status:number,value:unknown){
 if(res.headersSent)return;
 const body=JSON.stringify(value);
 res.writeHead(status,{
  'Content-Type':'application/json; charset=utf-8',
  'Content-Length':Buffer.byteLength(body),
  'Cache-Control':'private, no-store',
  'X-Content-Type-Options':'nosniff',
  'Content-Security-Policy':"default-src 'none'",
  'Referrer-Policy':'no-referrer'
 });res.end(body);
}
async function body(req:IncomingMessage,allowed:readonly string[]){
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
  req.headers['content-type']??''))throw new LocationError('M7_CONTENT_TYPE_REQUIRED');
 const length=Number(req.headers['content-length']??0);
 if(!Number.isSafeInteger(length)||length<0||length>MAX_BODY)
  throw new LocationError('M7_BODY_TOO_LARGE');
 const chunks:Buffer[]=[];let total=0;
 for await(const part of req){
  const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);
  total+=chunk.length;
  if(total>MAX_BODY)throw new LocationError('M7_BODY_TOO_LARGE');
  chunks.push(chunk);
 }
 let parsed:unknown;
 try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 catch{throw new LocationError('M7_REQUEST_INVALID');}
 assertKeys(parsed,allowed);
 return parsed as Record<string,unknown>;
}
export function createLocationsLabHttpServer({pool,cipher,authenticate}:Config){
 if(process.env.NODE_ENV==='production'||typeof authenticate!=='function')
  throw new LocationError('M7_LAB_HTTP_DISABLED');
 return createServer(async(req,res)=>{
  if(req.socket.localAddress!=='127.0.0.1'&&req.socket.localAddress!=='::1'){
   reply(res,403,{error:'M7_LOOPBACK_ONLY'});return;
  }
  try{
   const url=new URL(req.url??'/', 'http://127.0.0.1');
   const method=req.method??'',parts=url.pathname.split('/').filter(Boolean);
   if(url.pathname==='/v1/locations/health'&&method==='GET'){
    reply(res,200,{module:'locations',status:'lab_ready'});return;
   }
   const actor=await authenticate(req);
   if(!actor)throw new LocationError('M7_UNAUTHORIZED');
   uuid(actor.actorId);
   if(parts[0]!=='v1'||parts[1]!=='locations'){
    reply(res,404,{error:'M7_ROUTE_NOT_FOUND'});return;
   }
   const p=parts.slice(2);
   if(p.length===2&&p[0]==='coverage'&&p[1]==='v2'&&method==='GET'){
    const keys=[...url.searchParams.keys()];
    if(keys.length!==3||new Set(keys).size!==keys.length||
       keys.some(k=>!['city','latitude','longitude'].includes(k)))
      throw new LocationError('M7_REQUEST_INVALID');
    const locality=url.searchParams.get('city')??'',
      latitude=Number(url.searchParams.get('latitude')),
      longitude=Number(url.searchParams.get('longitude'));
    reply(res,200,await checkCoverageV2(pool,{city:locality,
      point:{latitude,longitude}}));return;
   }
   if(p.length===1&&p[0]==='polygons'&&method==='POST'){
    const data=await body(req,['operationId','slug','name','city','vertices']);
    reply(res,201,await createPolygonZone(pool,actor,data as never));return;
   }
   if(p.length===1&&p[0]==='polygons'&&method==='GET'){
    reply(res,200,{polygons:await listPolygonZones(pool,actor)});return;
   }
   if(p.length===2&&p[0]==='polygons'&&method==='PATCH'){
    const data=await body(req,['expectedVersion','name','vertices','status']);
    reply(res,200,await updatePolygonZone(pool,actor,{
      ...data,zoneId:uuid(p[1])
    } as never));return;
   }
   if(p.length===1&&p[0]==='coverage'&&method==='GET'){
    const keys=[...url.searchParams.keys()];
    if(keys.length!==3||new Set(keys).size!==keys.length||
       keys.some(k=>!['city','latitude','longitude'].includes(k)))
      throw new LocationError('M7_REQUEST_INVALID');
    const city=url.searchParams.get('city')??'';
    const latitude=Number(url.searchParams.get('latitude'));
    const longitude=Number(url.searchParams.get('longitude'));
    reply(res,200,await checkCoverage(pool,{city,point:{latitude,longitude}}));return;
   }
   if(p.length===1&&p[0]==='zones'&&method==='POST'){
    const data=await body(req,['operationId','slug','name','city',
      'center','radiusMeters']);
    reply(res,201,await createZone(pool,actor,data as never));return;
   }
   if(p.length===1&&p[0]==='zones'&&method==='GET'){
    reply(res,200,{zones:await listZones(pool,actor)});return;
   }
   if(p.length===2&&p[0]==='zones'&&method==='PATCH'){
    const data=await body(req,['expectedVersion','name','center',
      'radiusMeters','status']);
    reply(res,200,await updateZone(pool,actor,{
      ...data,zoneId:uuid(p[1])
    } as never));return;
   }
   if(p.length===1&&p[0]==='places'&&method==='POST'){
    const data=await body(req,['operationId','data','isDefault']);
    reply(res,201,await createPlace(pool,cipher,actor,data as never));return;
   }
   if(p.length===1&&p[0]==='places'&&method==='GET'){
    reply(res,200,{places:await listPlaces(pool,cipher,actor)});return;
   }
   if(p.length===2&&p[0]==='places'&&method==='PATCH'){
    const data=await body(req,['expectedVersion','patch']);
    reply(res,200,await updatePlace(pool,cipher,actor,{
      ...data,placeId:uuid(p[1])
    } as never));return;
   }
   if(p.length===3&&p[0]==='places'&&p[2]==='default'&&method==='PUT'){
    const data=await body(req,['expectedVersion']);
    reply(res,200,await setDefaultPlace(pool,actor,{
      ...data,placeId:uuid(p[1])
    } as never));return;
   }
   if(p.length===2&&p[0]==='places'&&method==='DELETE'){
    const data=await body(req,['expectedVersion']);
    reply(res,200,await deletePlace(pool,actor,{
      ...data,placeId:uuid(p[1])
    } as never));return;
   }
   if(p.length===1&&p[0]==='snapshot'&&method==='POST'){
    const data=await body(req,['purpose','point','accuracyMeters','consent']);
    reply(res,200,await putLocationSnapshot(pool,cipher,actor,data as never));return;
   }
   if(p.length===2&&p[0]==='snapshot'&&method==='GET'){
    reply(res,200,{snapshot:await getLocationSnapshot(pool,cipher,actor,p[1] as never)});
    return;
   }
   if(p.length===2&&p[0]==='snapshot'&&method==='DELETE'){
    await body(req,[]);
    reply(res,200,await clearLocationSnapshot(pool,actor,p[1] as never));return;
   }
   reply(res,404,{error:'M7_ROUTE_NOT_FOUND'});
  }catch(e){
   if(e instanceof LocationError){
    const status=e.code==='M7_UNAUTHORIZED'?401:e.code==='M7_FORBIDDEN'?403:
     e.code==='M7_CONTENT_TYPE_REQUIRED'?415:e.code==='M7_BODY_TOO_LARGE'?413:
     ['M7_VERSION_CONFLICT','M7_IDEMPOTENCY_CONFLICT','M7_PLACE_LIMIT',
      'M7_ZONE_EXISTS','M7_POLYGON_EXISTS'].includes(e.code)?409:
     e.code==='M7_PLACE_NOT_FOUND'?404:400;
    reply(res,status,{error:e.code});return;
   }
   reply(res,500,{error:'M7_INTERNAL_ERROR'});
  }
 });
}
