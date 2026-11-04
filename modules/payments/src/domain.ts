import {createHash} from 'node:crypto';
export class PaymentError extends Error {
 constructor(readonly code:string){super(code);this.name='PaymentError';}
}
export type Actor={actorId:string,canCreatePayments?:boolean,
 canRefundPayments?:boolean,canReadPayments?:boolean};
export type Money={amountCents:number,currency:'MXN'};
export const uuid=(v:unknown):string=>{
 if(typeof v!=='string'||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v))
  throw new PaymentError('M8_UUID_INVALID');
 return v.toLowerCase();
};
export function integer(v:unknown,min:number,max:number,code:string):number{
 if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)
  throw new PaymentError(code);
 return v;
}
export function amount(v:unknown){
 return integer(v,1,100_000_000,'M8_AMOUNT_INVALID');
}
export function currency(v:unknown):'MXN'{
 if(v!=='MXN')throw new PaymentError('M8_CURRENCY_INVALID');
 return 'MXN';
}
export function assertKeys(value:unknown,allowed:readonly string[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||
   Object.keys(value).some(key=>!allowed.includes(key)))
  throw new PaymentError('M8_REQUEST_INVALID');
}
export function requireActor(actor:Actor,capability:
 'canCreatePayments'|'canRefundPayments'|'canReadPayments'){
 const user=uuid(actor.actorId);
 if(actor[capability]!==true)throw new PaymentError('M8_FORBIDDEN');
 return user;
}
export function digest(value:unknown){
 return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
