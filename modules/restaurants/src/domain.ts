import {createHash} from 'node:crypto';
export class RestaurantError extends Error {
  constructor(readonly code:string){super(code);this.name='RestaurantError';}
}
export const KINDS=['restaurant','grocery','butcher','greengrocer',
  'stationery','hardware','florist','other'] as const;
export const CITIES=['tala','ameca','ahualulco','tequila','cuisillos','amatitan'] as const;
export const ROLES=['owner','manager','editor'] as const;
export type Kind=(typeof KINDS)[number];
export type City=(typeof CITIES)[number];
export type Role=(typeof ROLES)[number];
export type Actor={actorId:string};
export const uuid=(v:unknown):string=>{
  if(typeof v!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)))
    throw new RestaurantError('M6_UUID_INVALID');
  return v.toLowerCase();
};
export function field(v:unknown,min:number,max:number,code='M6_TEXT_INVALID'):string{
  if(typeof v!=='string')throw new RestaurantError(code);
  const s=v.trim();
  if(s.length<min||s.length>max||/[\u0000-\u0008\u000b-\u001f]/.test(s))
    throw new RestaurantError(code);
  return s;
}
export function slug(v:unknown){
  const s=field(v,2,60,'M6_SLUG_INVALID');
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s))
    throw new RestaurantError('M6_SLUG_INVALID');
  return s;
}
export function member<T extends string>(v:unknown,values:readonly T[],code:string):T{
  if(typeof v!=='string'||!values.includes(v as T))throw new RestaurantError(code);
  return v as T;
}
export function integer(v:unknown,min:number,max:number,code:string){
  if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)
    throw new RestaurantError(code);
  return v;
}
export function optionalText(v:unknown,max:number){
  if(v===undefined)return '';
  if(typeof v!=='string')throw new RestaurantError('M6_TEXT_INVALID');
  return field(v,0,max);
}
export function digest(v:unknown){
  return createHash('sha256').update(JSON.stringify(v)).digest('hex');
}
export function assertKeys(v:unknown,allowed:readonly string[]){
  if(!v||typeof v!=='object'||Array.isArray(v)||
    Object.keys(v).some(k=>!allowed.includes(k)))
    throw new RestaurantError('M6_REQUEST_INVALID');
}
export const person=(ctx:Actor)=>uuid(ctx.actorId);
