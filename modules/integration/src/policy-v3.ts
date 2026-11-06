/** M11 verifies owner-approved v3 money facts independently of M1.
 * This is a settlement/financial-boundary guard: it does NOT price carts,
 * perform gateway operations, authorize withdrawals, or rewrite old journals.
 * Historical v2 snapshots remain immutable and require separate migration
 * review; they must NOT be silently relabeled as v3.
 */
import {IntegrationError} from './events.js';

export const APPROVED_POLICY_V3='pilot-2026-11-v3-17pct-7pct-uncapped';
const FIELDS=['itemsMinor','merchantCommissionMinor','merchantPayableMinor',
 'serviceFeeMinor','deliveryFeeMinor','driverPayableMinor','tipMinor',
 'totalMinor','platformGrossMinor'] as const;
type MoneyKey=typeof FIELDS[number];
const valid=/^(0|[1-9][0-9]{0,15})$/;
const max=1_000_000_000_000n;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pct=(x:bigint,bps:bigint)=>(x*bps+5_000n)/10_000n;
const reject=():never=>{throw new IntegrationError('M11_PRICING_POLICY_MISMATCH');};

/** Strict integer-cents replay check before any M11→M3 journal or M8 payment
 * finalization. No caller may dictate merchant commission, customer service
 * or platform split through a loose versioned JSON snapshot.
 */
export function requireApprovedV3Snapshot(
 raw:unknown,fulfillment:'pickup'|'delivery',orderTotal:string
){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!valid.test(orderTotal))
  reject();
 const value=raw as Record<string,unknown>;
 if(value.policyVersion!==APPROVED_POLICY_V3||
    !['pickup','delivery'].includes(fulfillment)||
    // Historical M1 CASH snapshots omit these two fields; if present,
    // they must agree with the trusted order row. Stripe LAB includes both.
    (value.currency!==undefined&&value.currency!=='MXN')||
    (value.fulfillment!==undefined&&value.fulfillment!==fulfillment))reject();
 const m={} as Record<MoneyKey,bigint>;
 for(const key of FIELDS){
  const rawMinor=value[key];
  if(typeof rawMinor!=='string'||!valid.test(rawMinor))reject();
  m[key]=BigInt(rawMinor as string);
  if(m[key]>max)reject();
 }
 // Both M1 CASH and M1 Stripe TEST persist frozen line items. An otherwise
 // internally balanced snapshot is NOT enough if its product totals were
 // changed without changing the actual frozen line prices/quantities.
 const lines=value.lines;
 if(!Array.isArray(lines))return reject();
 if(lines.length<1||lines.length>100)return reject();
 let lineTotal=0n;
 const seen=new Set<string>();
 for(const entry of lines){
  if(!entry||typeof entry!=='object'||Array.isArray(entry))
   return reject();
  const line=entry as Record<string,unknown>;
  const productId=line.productId,unitMinor=line.unitMinor;
  const quantity=line.quantity;
  if(typeof productId!=='string')return reject();
  if(!uuid.test(productId)||seen.has(productId.toLowerCase()))
   return reject();
  if(typeof unitMinor!=='string'||!valid.test(unitMinor))
   return reject();
  if(typeof quantity!=='number'||!Number.isSafeInteger(quantity)||
     quantity<1||quantity>100)return reject();
  seen.add(productId.toLowerCase());
  const unit=BigInt(unitMinor);
  if(unit>max)return reject();
  lineTotal+=unit*BigInt(quantity);
  if(lineTotal>max)return reject();
 }
 const items=m.itemsMinor,fee=m.serviceFeeMinor,commission=m.merchantCommissionMinor;
 if(items!==lineTotal)reject();
 if(items===0n||commission!==pct(items,1_700n)||
    fee!==pct(items,700n)||m.merchantPayableMinor!==items-commission||
    m.totalMinor!==items+fee+m.deliveryFeeMinor+m.tipMinor||
    m.totalMinor!==BigInt(orderTotal)||
    m.platformGrossMinor!==m.totalMinor-m.merchantPayableMinor-m.driverPayableMinor||
    m.platformGrossMinor<0n)reject();
 if(fulfillment==='pickup'){
  if(m.deliveryFeeMinor!==0n||m.driverPayableMinor!==0n||
     m.tipMinor!==0n)reject();
 }else{
  // Driver earnings include the FULL gratuity; the platform's margin may
  // NEVER take a percentage or rounding deduction from a tip.
  if(m.deliveryFeeMinor<=0n||m.driverPayableMinor<=m.tipMinor)reject();
 }
 const normalized=Object.fromEntries(
  FIELDS.map(k=>[k,m[k].toString()])) as Record<MoneyKey,string>;
 return Object.freeze({currency:'MXN' as const,
  policyVersion:APPROVED_POLICY_V3,fulfillment,...normalized
 });
}
