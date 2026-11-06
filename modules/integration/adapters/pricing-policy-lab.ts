/**
 * LAB9 adapter policy boundary: M1 authoritative lines to M3 held ledger.
 * The owner-approved pilot policy is 17% merchant commission / 7% service fee.
 * Preserve M1's existing $25.00 MXN service fee cap; changing that cap needs
 * separate commercial review. No payouts, no external charges and no LIVE flag.
 */
import {quoteOrder,PRICING_POLICY_VERSION}
 from '../../../src/modules/orders/pricing.ts';
import {IntegrationError} from '../src/events.js';

const PILOT_POLICY='pilot-2026-11-v2-17pct';
const MONEY_KEYS=[
 'itemsMinor','merchantCommissionMinor','merchantPayableMinor',
 'serviceFeeMinor','deliveryFeeMinor','driverPayableMinor','tipMinor',
 'totalMinor','platformGrossMinor'
] as const;
type MoneyKey=typeof MONEY_KEYS[number];
type Fulfillment='pickup'|'delivery';
export type ApprovedM11Snapshot=Readonly<{
 currency:'MXN',policyVersion:typeof PILOT_POLICY,
 fulfillment:Fulfillment
} & Record<MoneyKey,string>>;
type Line=Readonly<{unitMinor:string,quantity:number}>;

const rejected=():never=>{
 throw new IntegrationError('M11_FINANCE_SNAPSHOT_INVALID');
};
function minor(value:unknown):bigint{
 if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,14})$/.test(value))
  return rejected();
 return BigInt(value);
}

/** Recompute a persisted order's complete allocation from its ORIGINAL lines.
 * M1 cash snapshots predate currency/fulfillment fields: these are sourced\n * exclusively from the trusted order record, not the browser. If present in\n * the snapshot they must match the trusted values.\n * Never trust an amount/version supplied by a browser or integration event.
 * For delivery, base courier amount is derived only to validate consistency:
 * the real driver assignment and entitlement still require M2/M3 settlement.
 */
export function verifyApprovedM11PricingSnapshot(input:{
 raw:unknown,orderTotalMinor:string,fulfillment:Fulfillment,
 lines:readonly Line[]
}):ApprovedM11Snapshot{
 const s=input.raw;
 if(!s||typeof s!=='object'||Array.isArray(s))
  return rejected();
 const obj=s as Record<string,unknown>;
 if(PRICING_POLICY_VERSION!==PILOT_POLICY||
    obj.policyVersion!==PILOT_POLICY||
    (obj.currency!==undefined&&obj.currency!=='MXN')||
    (obj.fulfillment!==undefined&&obj.fulfillment!==input.fulfillment)||
    !['pickup','delivery'].includes(input.fulfillment)||
    !Array.isArray(input.lines)||input.lines.length===0||
    input.lines.length>100)
  return rejected();
 try{
  const lines=input.lines.map(line=>{
   if(!Number.isSafeInteger(line.quantity)||line.quantity<1||
      line.quantity>1000)return rejected();
   return {unitMinor:minor(line.unitMinor),quantity:line.quantity};
  });
  const deliveryFeeMinor=minor(obj.deliveryFeeMinor);
  const tipMinor=minor(obj.tipMinor);
  const courierMinor=minor(obj.driverPayableMinor);
  if(courierMinor<tipMinor)return rejected();
  const q=quoteOrder({lines,fulfillment:input.fulfillment,
   deliveryFeeMinor,driverBaseMinor:courierMinor-tipMinor,tipMinor});
  const expected:ApprovedM11Snapshot={
   currency:'MXN',policyVersion:PILOT_POLICY,
   fulfillment:input.fulfillment,
   itemsMinor:q.itemsMinor.toString(),
   merchantCommissionMinor:q.merchantCommissionMinor.toString(),
   merchantPayableMinor:q.merchantPayableMinor.toString(),
   serviceFeeMinor:q.serviceFeeMinor.toString(),
   deliveryFeeMinor:q.deliveryFeeMinor.toString(),
   driverPayableMinor:q.driverPayableMinor.toString(),
   tipMinor:q.tipMinor.toString(),
   totalMinor:q.totalMinor.toString(),
   platformGrossMinor:q.platformGrossMinor.toString()
  };
  if(expected.totalMinor!==input.orderTotalMinor||
     MONEY_KEYS.some(key=>obj[key]!==expected[key]))
   return rejected();
  return Object.freeze(expected);
 }catch(error){
  if(error instanceof IntegrationError)throw error;
  return rejected();
 }
}
