/** M11 boundary messages are minimal, versioned and internal.
 * No money, buyer data, address, GPS, credentials or Stripe TEST facts.
 * Source modules must produce from their OWN durable outbox in production.
 */
export class IntegrationError extends Error{
 constructor(readonly code:string){super(code);this.name='IntegrationError';}
}
export const ROUTES={
 'orders.order_created':{source:'orders',consumers:[]},
 'restaurants.order_ready':{source:'restaurants',consumers:['logistics','notifications']},
 'logistics.delivery_completed':{source:'logistics',consumers:['notifications','analytics']}
} as const;
export type EventKind=keyof typeof ROUTES;
export type Producer='orders'|'restaurants'|'logistics';
export type Consumer='notifications'|'logistics'|'analytics';
export type IntegrationEvent={
 schemaVersion:1,eventId:string,source:Producer,kind:EventKind,
 merchantId:string,orderId:string,occurredAt:string
};
const KEYS=['schemaVersion','eventId','source','kind','merchantId',
 'orderId','occurredAt'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function validUuid(x:unknown):string{
 if(typeof x!=='string'||!UUID.test(x))
  throw new IntegrationError('M11_UUID_INVALID');
 return x.toLowerCase();
}
export function validateEnvelope(raw:unknown,now=Date.now()):IntegrationEvent{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))
  throw new IntegrationError('M11_EVENT_INVALID');
 const o=raw as Record<string,unknown>;
 if(Object.keys(o).length!==KEYS.length||
    KEYS.some(k=>!Object.hasOwn(o,k))||
    Object.keys(o).some(k=>!KEYS.includes(k))||
    o.schemaVersion!==1||typeof o.kind!=='string'||
    !Object.hasOwn(ROUTES,o.kind))
  throw new IntegrationError('M11_EVENT_INVALID');
 const kind=o.kind as EventKind;
 if(o.source!==ROUTES[kind].source)
  throw new IntegrationError('M11_SOURCE_MISMATCH');
 let eventId:string,merchantId:string,orderId:string;
 try{
  eventId=validUuid(o.eventId);
  merchantId=validUuid(o.merchantId);
  orderId=validUuid(o.orderId);
 }catch{throw new IntegrationError('M11_EVENT_INVALID');}
 if(typeof o.occurredAt!=='string'||
   !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(o.occurredAt))
  throw new IntegrationError('M11_TIME_INVALID');
 const date=Date.parse(o.occurredAt);
 if(!Number.isFinite(date)||
   new Date(date).toISOString()!==o.occurredAt.replace(/Z$/,'.000Z')||
   date>now+300000||date<now-30*86400000)
  throw new IntegrationError('M11_TIME_INVALID');
 return Object.freeze({
  schemaVersion:1,eventId,source:o.source as Producer,kind,merchantId,
  orderId,occurredAt:o.occurredAt
 });
}
export function routing(kind:EventKind):ReadonlyArray<Consumer>{
 return ROUTES[kind].consumers as unknown as ReadonlyArray<Consumer>;
}
