/** M5: typed event contracts only; NO imports from any other module.
 * Producers MUST authenticate outside this package before publishing.
 */
import {createHash} from 'node:crypto';

export class NotificationError extends Error{
  constructor(readonly code:string){super(code);this.name='NotificationError';}
}
export const APPS=['customer','restaurant','courier','admin'] as const;
export type App=(typeof APPS)[number];
export type Category='transactional'|'security'|'marketing';
export type Channel='in_app'|'push'|'email';
type Definition={
  app:App,category:Category,title:string,body:string,route:string,
  push:boolean,email:boolean
};
export const EVENT_CATALOG={
  'order.confirmed':{app:'customer',category:'transactional',
    title:'Pedido confirmado',body:'Recibimos tu pedido.',
    route:'/pedidos',push:true,email:true},
  'order.accepted':{app:'customer',category:'transactional',
    title:'Pedido aceptado',body:'El establecimiento aceptó tu pedido.',
    route:'/pedidos',push:true,email:false},
  'order.preparing':{app:'customer',category:'transactional',
    title:'Preparando tu pedido',body:'Tu pedido está en preparación.',
    route:'/pedidos',push:true,email:false},
  'order.ready':{app:'customer',category:'transactional',
    title:'Tu pedido está listo',body:'Tu pedido ya está preparado.',
    route:'/pedidos',push:true,email:false},
  'order.picked_up':{app:'customer',category:'transactional',
    title:'Pedido en camino',body:'Un repartidor recogió tu pedido.',
    route:'/pedidos',push:true,email:false},
  'order.delivered':{app:'customer',category:'transactional',
    title:'Pedido entregado',body:'Se registró la entrega de tu pedido.',
    route:'/pedidos',push:true,email:true},
  'order.cancelled':{app:'customer',category:'transactional',
    title:'Pedido cancelado',body:'Tu pedido fue cancelado.',
    route:'/pedidos',push:true,email:true},
  'order.refund_status':{app:'customer',category:'transactional',
    title:'Actualización de reembolso',body:'Consulta la actualización de tu reembolso.',
    route:'/pedidos',push:true,email:true},
  'restaurant.new_order':{app:'restaurant',category:'transactional',
    title:'Nuevo pedido recibido',body:'Tienes un pedido pendiente de aceptar.',
    route:'/restaurante/pedidos',push:true,email:true},
  'restaurant.order_cancelled':{app:'restaurant',category:'transactional',
    title:'Pedido cancelado',body:'Revisa la cancelación de un pedido.',
    route:'/restaurante/pedidos',push:true,email:false},
  'restaurant.settlement_ready':{app:'restaurant',category:'transactional',
    title:'Estado de cuenta disponible',body:'Consulta tu nuevo estado de cuenta.',
    route:'/restaurante/finanzas',push:true,email:true},
  'restaurant.menu_alert':{app:'restaurant',category:'transactional',
    title:'Revisa tu menú',body:'Un producto requiere tu atención.',
    route:'/restaurante/menu',push:true,email:false},
  'courier.offer':{app:'courier',category:'transactional',
    title:'Nueva solicitud de entrega',body:'Tienes una solicitud para revisar.',
    route:'/repartidor/solicitudes',push:true,email:false},
  'courier.assigned':{app:'courier',category:'transactional',
    title:'Entrega asignada',body:'Consulta los detalles de tu nueva entrega.',
    route:'/repartidor/entregas',push:true,email:false},
  'courier.pickup_ready':{app:'courier',category:'transactional',
    title:'Pedido listo para recoger',body:'El establecimiento indicó que está listo.',
    route:'/repartidor/entregas',push:true,email:false},
  'courier.earnings_ready':{app:'courier',category:'transactional',
    title:'Resumen disponible',body:'Consulta tu resumen de ganancias.',
    route:'/repartidor/finanzas',push:true,email:true},
  'admin.support_ticket':{app:'admin',category:'transactional',
    title:'Nuevo caso de soporte',body:'Hay un caso que requiere revisión.',
    route:'/admin/soporte',push:true,email:true},
  'admin.risk_alert':{app:'admin',category:'security',
    title:'Alerta de seguridad',body:'Revisa una alerta de seguridad de la plataforma.',
    route:'/admin/seguridad',push:true,email:true},
  'identity.password_changed':{app:'customer',category:'security',
    title:'Contraseña actualizada',body:'Se actualizó la contraseña de tu cuenta.',
    route:'/cuenta/seguridad',push:true,email:true},
  'identity.new_login':{app:'customer',category:'security',
    title:'Nuevo inicio de sesión',body:'Detectamos un acceso nuevo a tu cuenta.',
    route:'/cuenta/seguridad',push:true,email:true},
  'support.reply':{app:'customer',category:'transactional',
    title:'Respuesta de soporte',body:'El equipo de soporte respondió tu solicitud.',
    route:'/soporte',push:true,email:true},
  'marketing.promotion':{app:'customer',category:'marketing',
    title:'Novedades en Tala Eats',body:'Hay una promoción que puede interesarte.',
    route:'/promociones',push:true,email:true}
} as const satisfies Record<string,Definition>;

export type EventType=keyof typeof EVENT_CATALOG;
export const uuid=(value:unknown):string=>{
  if(typeof value!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)))
    throw new NotificationError('NOTIFICATIONS_UUID_INVALID');
  return value.toLowerCase();
};
export const appValue=(value:unknown):App=>{
  if(typeof value!=='string'||!APPS.includes(value as App))
    throw new NotificationError('NOTIFICATIONS_APP_INVALID');
  return value as App;
};
export const categoryValue=(value:unknown):Category=>{
  if(value!=='transactional'&&value!=='security'&&value!=='marketing')
    throw new NotificationError('NOTIFICATIONS_CATEGORY_INVALID');
  return value;
};
export const channelValue=(value:unknown):Channel=>{
  if(value!=='in_app'&&value!=='push'&&value!=='email')
    throw new NotificationError('NOTIFICATIONS_CHANNEL_INVALID');
  return value;
};
export const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type PublishInput={
  sourceEventId:string,recipientId:string,app:App,eventType:EventType,
  resourceId?:string
};
export function render(input:PublishInput){
  if(!input||typeof input!=='object'||Array.isArray(input)||
     Object.keys(input).some(k=>!['sourceEventId','recipientId','app',
       'eventType','resourceId'].includes(k)))
    throw new NotificationError('NOTIFICATIONS_EVENT_INVALID');
  const recipientId=uuid(input.recipientId);
  const sourceEventId=uuid(input.sourceEventId);
  const app=appValue(input.app);
  if(typeof input.eventType!=='string'||
     !Object.hasOwn(EVENT_CATALOG,input.eventType))
    throw new NotificationError('NOTIFICATIONS_EVENT_UNKNOWN');
  const eventType=input.eventType as EventType;
  const definition=EVENT_CATALOG[eventType];
  if(definition.app!==app)
    throw new NotificationError('NOTIFICATIONS_AUDIENCE_MISMATCH');
  const resourceId=input.resourceId===undefined?null:uuid(input.resourceId);
  const data=resourceId?{resourceId}:{} as {resourceId?:string};
  const deepLink=definition.route+(resourceId?'?ref='+resourceId:'');
  // Strictly catalog-derived priority. No user-supplied "urgent" flag.
  const priority=definition.category==='security'?100:
    (['courier.offer','courier.assigned'] as string[]).includes(eventType)?95:
    (['restaurant.new_order','courier.pickup_ready'] as string[]).includes(eventType)?90:
    (['order.ready','order.picked_up','order.delivered',
      'order.cancelled','order.refund_status'] as string[]).includes(eventType)?80:
    definition.category==='marketing'?10:60;
  return Object.freeze({recipientId,sourceEventId,app,eventType,priority,
    category:definition.category,title:definition.title,body:definition.body,
    deepLink,data,channelPush:definition.push,channelEmail:definition.email,
    contentFingerprint:hash([app,eventType,resourceId])});
}
