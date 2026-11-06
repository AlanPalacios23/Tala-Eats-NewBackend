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
    !['pickup','delivery'].includes(fulfillment))reject();
 const m={} as Record<MoneyKey,bigint>;
 for(const key of FIELDS){
  const rawMinor=value[key];
  if(typeof rawMinor!=='string'||!valid.test(rawMinor))reject();
  m[key]=BigInt(rawMinor);
  if(m[key]>max)reject();
 }
 const items=m.itemsMinor,fee=m.serviceFeeMinor,commission=m.merchantCommissionMinor;
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
 return Object.freeze({currency:'MXN' as const,
  policyVersion:APPROVED_POLICY_V3,fulfillment,
  ...Object.fromEntries(FIELDS.map(k=>[k,m[k].toString()]))
 });
}
