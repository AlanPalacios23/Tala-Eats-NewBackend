/** Future Tala Eats Crece features: proposals only, no commercial writes.
 * Validate every field, reject unknown fields, and keep money in centavos.
 * M1/M3/M6/M8 remain the source of truth for actual commerce and products.
 */
import {IntegrationError,validUuid} from '../src/events.js';
export const CRECE_FUTURE_IDS=[
 'cupones','temporadas','programados','combos','sucursales',
 'fidelidad','empresas','calidad'
] as const;
export type CreceFutureId=(typeof CRECE_FUTURE_IDS)[number];
type Shape=Record<string,unknown>;
const reject=(code='M11_CRECE_PROPOSAL_INVALID'):never=>{
 throw new IntegrationError(code);
};
const object=(raw:unknown,keys:readonly string[])=>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))reject();
 const obj=raw as Shape;
 if(Object.keys(obj).length!==keys.length||
    Object.keys(obj).some(k=>!keys.includes(k))||
    keys.some(k=>!Object.hasOwn(obj,k)))reject();
 return obj;
};
const integer=(n:unknown,min:number,max:number)=>{
 if(!Number.isSafeInteger(n)||(n as number)<min||(n as number)>max)reject();
 return n as number;
};
const txt=(s:unknown,min=2,max=90)=>{
 if(typeof s!=='string'||s.trim().length<min||
   s.trim().length>max||/[\u0000-\u001f\u007f]/.test(s))reject();
 return s.trim();
};
const date=(s:unknown)=>{
 if(typeof s!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(s)||
  !Number.isFinite(Date.parse(s))||
  new Date(s).toISOString().slice(0,10)!==s)reject();
 return s;
};
const city=(s:unknown)=>{
 if(!['Tala','Ameca','Ahualulco de Mercado','Tequila','Cuisillos',
  'Amatitán'].includes(String(s)))reject();
 return s as string;
};
export function normalizeCreceDraft(id:unknown,proposal:unknown):Shape{
 if(!CRECE_FUTURE_IDS.includes(id as CreceFutureId))
  reject('M11_CRECE_DRAFT_FEATURE_INVALID');
 let p:Shape;
 switch(id){
 case 'cupones':{
  p=object(proposal,['code','percentBps','maxUses','expiresOn']);
  const code=txt(p.code,4,16).toUpperCase();
  if(!/^[A-Z0-9_-]+$/.test(code))reject();
  return {code,percentBps:integer(p.percentBps,100,5000),
   maxUses:integer(p.maxUses,1,10000),expiresOn:date(p.expiresOn)};
 }
 case 'temporadas':{
  p=object(proposal,['title','startsOn','endsOn','budgetMinor']);
  const startsOn=date(p.startsOn),endsOn=date(p.endsOn);
  const days=(Date.parse(endsOn)-Date.parse(startsOn))/86400000;
  if(days<0||days>366)reject();
  return {title:txt(p.title),startsOn,endsOn,
   budgetMinor:integer(p.budgetMinor,0,100000000)};
 }
 case 'programados':{
  p=object(proposal,['prepMinutes','leadHours','maxConcurrent']);
  return {prepMinutes:integer(p.prepMinutes,5,240),
   leadHours:integer(p.leadHours,1,168),
   maxConcurrent:integer(p.maxConcurrent,1,100)};
 }
 case 'combos':{
  p=object(proposal,['title','variants','priceMinor']);
  if(!Array.isArray(p.variants)||p.variants.length<2||
    p.variants.length>8)reject();
  const variants=p.variants.map(v=>{
   const item=object(v,['variantId','quantity']);
   return {variantId:validUuid(item.variantId),
    quantity:integer(item.quantity,1,20)};
  });
  if(new Set(variants.map(v=>v.variantId)).size!==variants.length)reject();
  return {title:txt(p.title),variants,
   priceMinor:integer(p.priceMinor,100,100000000)};
 }
 case 'sucursales':{
  p=object(proposal,['name','city','district']);
  return {name:txt(p.name),city:city(p.city),
   district:txt(p.district,2,100)};
 }
 case 'fidelidad':{
  p=object(proposal,['pointsPer100Pesos','maxPoints','expiresDays']);
  return {pointsPer100Pesos:integer(p.pointsPer100Pesos,1,100),
   maxPoints:integer(p.maxPoints,100,100000),
   expiresDays:integer(p.expiresDays,30,365)};
 }
 case 'empresas':{
  p=object(proposal,['minPeople','minimumNoticeHours','note']);
  return {minPeople:integer(p.minPeople,5,1000),
   minimumNoticeHours:integer(p.minimumNoticeHours,4,240),
   note:txt(p.note,8,200)};
 }
 case 'calidad':{
  p=object(proposal,['minDelivered','maxCancellationBps','maxLateBps']);
  return {minDelivered:integer(p.minDelivered,10,100000),
   maxCancellationBps:integer(p.maxCancellationBps,0,1000),
   maxLateBps:integer(p.maxLateBps,0,1000)};
 }
 default:return reject('M11_CRECE_DRAFT_FEATURE_INVALID');
 }
}
