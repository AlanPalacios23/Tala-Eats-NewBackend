/** LAB-only contract smoke across the TEN module boundaries.
 * All adapters are injected. This does NOT execute a real M1-M10 flow,
 * charge money, or prove actual production integration.
 */
import {IntegrationError,validUuid} from './events.js';
export type LabOrder={
 orderId:string,merchantId:string,customerId:string,totalCents:number
};
export interface TenModulePorts{
 users:{verifyLabIdentity:(customerId:string)=>Promise<{verified:boolean}>};
 security:{requireLabAuthorization:(orderId:string)=>Promise<{allowed:boolean}>};
 locations:{verifyLabZone:(merchantId:string)=>Promise<{covered:boolean}>};
 restaurants:{
  quoteLab:(orderId:string,merchantId:string)=>Promise<{merchantId:string,totalCents:number}>;
  prepareLab:(orderId:string)=>Promise<{ready:boolean}>
 };
 orders:{createLabOrder:(order:LabOrder)=>Promise<{
  orderId:string,merchantId:string,totalCents:number
 }>};
 payments:{simulateLabPayment:(orderId:string,totalCents:number)=>Promise<{
  provider:'simulated_lab',livemode:false,amountCents:number,confirmed:boolean
 }>};
 logistics:{simulateLabDelivery:(orderId:string)=>Promise<{delivered:boolean}>};
 finance:{previewLabLedger:(orderId:string,amountCents:number)=>Promise<{
  previewOnly:true,writesPerformed:false,amountCents:number
 }>};
 notifications:{queueLabNotification:(orderId:string)=>Promise<{queued:boolean}>};
 analytics:{previewLabMetrics:(orderId:string)=>Promise<{
  derivedOnly:true,liveData:false
 }>};
}
function asserted(value:unknown,code:string):asserts value{
 if(value!==true)throw new IntegrationError(code);
}
export async function runIsolatedTenModuleSmoke(ports:TenModulePorts,
 raw:LabOrder){
 if(process.env.NODE_ENV==='production')
  throw new IntegrationError('M11_COMMERCIAL_DISABLED');
 const order:LabOrder={orderId:validUuid(raw.orderId),
  merchantId:validUuid(raw.merchantId),
  customerId:validUuid(raw.customerId),totalCents:raw.totalCents};
 if(!Number.isSafeInteger(order.totalCents)||
   order.totalCents<1||order.totalCents>100_000_000)
  throw new IntegrationError('M11_INVALID_AMOUNT');
 asserted((await ports.users.verifyLabIdentity(order.customerId)).verified,
  'M11_IDENTITY_REJECTED');
 asserted((await ports.security.requireLabAuthorization(order.orderId)).allowed,
  'M11_SECURITY_REJECTED');
 asserted((await ports.locations.verifyLabZone(order.merchantId)).covered,
  'M11_ZONE_REJECTED');
 const quote=await ports.restaurants.quoteLab(order.orderId,order.merchantId);
 if(quote.merchantId!==order.merchantId||
   quote.totalCents!==order.totalCents)
  throw new IntegrationError('M11_QUOTE_MISMATCH');
 const created=await ports.orders.createLabOrder(order);
 if(created.orderId!==order.orderId||
   created.merchantId!==order.merchantId||
   created.totalCents!==order.totalCents)
  throw new IntegrationError('M11_ORDER_MISMATCH');
 const testPayment=await ports.payments.simulateLabPayment(order.orderId,
  order.totalCents);
 if(testPayment.provider!=='simulated_lab'||testPayment.livemode!==false||
   testPayment.amountCents!==order.totalCents||
   testPayment.confirmed!==true)
  throw new IntegrationError('M11_TEST_PAYMENT_REJECTED');
 asserted((await ports.restaurants.prepareLab(order.orderId)).ready,
  'M11_RESTAURANT_NOT_READY');
 asserted((await ports.logistics.simulateLabDelivery(order.orderId)).delivered,
  'M11_DELIVERY_INCOMPLETE');
 const dryRun=await ports.finance.previewLabLedger(order.orderId,
  order.totalCents);
 if(dryRun.previewOnly!==true||dryRun.writesPerformed!==false||
   dryRun.amountCents!==order.totalCents)
  throw new IntegrationError('M11_FINANCE_PREVIEW_INVALID');
 asserted((await ports.notifications.queueLabNotification(order.orderId)).queued,
  'M11_NOTIFICATIONS_FAILED');
 const metrics=await ports.analytics.previewLabMetrics(order.orderId);
 if(metrics.derivedOnly!==true||metrics.liveData!==false)
  throw new IntegrationError('M11_ANALYTICS_LAB_ONLY');
 return Object.freeze({mode:'isolated-lab' as const,orderId:order.orderId,
  modulesExercised:10 as const,liveWrites:false as const,
  paymentProvider:'simulated_lab' as const});
}
