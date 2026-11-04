import {createHash} from 'node:crypto';
export class LocationError extends Error {
 constructor(readonly code:string){super(code);this.name='LocationError';}
}
export const CITIES=['tala','ameca','ahualulco','tequila','cuisillos','amatitan'] as const;
export type City=typeof CITIES[number];
export type Point={latitude:number,longitude:number};
/** Only the trusted host assigns these permissions, never the request body. */
export type Actor={
 actorId:string,
 canManageZones?:boolean,
 /** Foreground opt-in or verified active-delivery tracking, checked by host. */
 locationConsentPurposes?:readonly ('foreground'|'active_delivery')[]
};
export const uuid=(v:unknown):string=>{
 if(typeof v!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)))
   throw new LocationError('M7_UUID_INVALID');
 return v.toLowerCase();
};
export function textField(v:unknown,min:number,max:number,code='M7_TEXT_INVALID'):string{
 if(typeof v!=='string')throw new LocationError(code);
 const s=v.trim();
 if(s.length<min||s.length>max||/[\u0000-\u001f\u007f]/.test(s))
   throw new LocationError(code);
 return s;
}
export function slug(v:unknown){
 const s=textField(v,2,60,'M7_SLUG_INVALID');
 if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s))
   throw new LocationError('M7_SLUG_INVALID');
 return s;
}
export function member<T extends string>(v:unknown,values:readonly T[],code:string):T{
 if(typeof v!=='string'||!values.includes(v as T))throw new LocationError(code);
 return v as T;
}
export function integer(v:unknown,min:number,max:number,code:string){
 if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)
   throw new LocationError(code);
 return v;
}
function coord(v:unknown,min:number,max:number){
 if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)
   throw new LocationError('M7_COORDINATES_INVALID');
 // SQL NUMERIC(9,6) consistency; never allow a rounded value outside bounds.
 return Math.round(v*1_000_000)/1_000_000;
}
export function point(v:unknown):Point{
 if(!v||typeof v!=='object'||Array.isArray(v))
   throw new LocationError('M7_COORDINATES_INVALID');
 const p=v as Record<string,unknown>;
 if(Object.keys(p).some(k=>!['latitude','longitude'].includes(k)))
   throw new LocationError('M7_COORDINATES_INVALID');
 return Object.freeze({latitude:coord(p.latitude,-90,90),
   longitude:coord(p.longitude,-180,180)});
}
export function city(v:unknown){return member(v,CITIES,'M7_CITY_INVALID');}
export function digest(v:unknown){
 return createHash('sha256').update(JSON.stringify(v)).digest('hex');
}
export function assertKeys(v:unknown,allowed:readonly string[]){
 if(!v||typeof v!=='object'||Array.isArray(v)||
    Object.keys(v).some(k=>!allowed.includes(k)))
   throw new LocationError('M7_REQUEST_INVALID');
}
export function operator(actor:Actor):string{
 const id=uuid(actor.actorId);
 if(actor.canManageZones!==true)throw new LocationError('M7_FORBIDDEN');
 return id;
}
/** Great-circle distance in metres. Only approximate coverage; not a route or delivery promise. */
export function distanceMeters(a:Point,b:Point):number{
 const x=point(a),y=point(b),rad=Math.PI/180;
 const dLat=(y.latitude-x.latitude)*rad,dLon=(y.longitude-x.longitude)*rad;
 const aa=Math.sin(dLat/2)**2+Math.cos(x.latitude*rad)*
   Math.cos(y.latitude*rad)*Math.sin(dLon/2)**2;
 return 6371008.8*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,aa))));
}
