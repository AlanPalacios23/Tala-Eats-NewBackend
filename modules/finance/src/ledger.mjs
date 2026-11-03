/**
 * TALA EATS CORE v2 / M3 finance foundation.
 * PURE proposals only: no database, Stripe requests, transfers or paid status.
 * The caller MUST verify provider evidence independently before any persistence.
 */
import {createHash} from 'node:crypto';

export class FinanceError extends Error {
  constructor(code) { super(code); this.code=code; this.name='FinanceError'; }
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL=/^(0|[1-9][0-9]{0,15})$/;
const MAX_MINOR=1_000_000_000_000n; // MXN minor units; deliberately conservative
const moneyFields=[
  'itemsMinor','merchantCommissionMinor','merchantPayableMinor',
  'serviceFeeMinor','deliveryFeeMinor','driverPayableMinor','tipMinor',
  'totalMinor','platformGrossMinor'
];
const bounded=(value)=>{
  if(typeof value!=='string'||!DECIMAL.test(value))throw new FinanceError('MONEY_FORMAT_INVALID');
  const parsed=BigInt(value);
  if(parsed>MAX_MINOR)throw new FinanceError('MONEY_OUT_OF_RANGE');
  return parsed;
};
const positiveUuid=(value)=>typeof value==='string'&&UUID.test(value);
const hash=(value)=>createHash('sha256').update(value).digest('hex');
const add=(a,b)=>a+b;

export function validateFinancialSnapshot(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))
    throw new FinanceError('SNAPSHOT_INVALID');
  if(input.currency!=='MXN'||!['pickup','delivery'].includes(input.fulfillment)||
    typeof input.policyVersion!=='string'||!/^[A-Za-z0-9_.:-]{1,96}$/.test(input.policyVersion))
    throw new FinanceError('SNAPSHOT_CONTRACT_INVALID');
  const m=Object.fromEntries(moneyFields.map(field=>[field,bounded(input[field])]));
  if(m.itemsMinor===0n||m.merchantCommissionMinor>m.itemsMinor||
    m.merchantPayableMinor!==m.itemsMinor-m.merchantCommissionMinor)
    throw new FinanceError('MERCHANT_BALANCE_INVALID');
  if(m.totalMinor!==m.itemsMinor+m.serviceFeeMinor+m.deliveryFeeMinor+m.tipMinor)
    throw new FinanceError('CUSTOMER_TOTAL_INVALID');
  if(m.platformGrossMinor!==m.totalMinor-m.merchantPayableMinor-m.driverPayableMinor||
     m.driverPayableMinor+m.merchantPayableMinor>m.totalMinor)
    throw new FinanceError('PAYOUT_BALANCE_INVALID');
  if(input.fulfillment==='pickup'&&
    (m.deliveryFeeMinor!==0n||m.driverPayableMinor!==0n||m.tipMinor!==0n))
    throw new FinanceError('PICKUP_FINANCE_INVALID');
  if(input.fulfillment==='delivery'&&m.deliveryFeeMinor===0n)
    throw new FinanceError('DELIVERY_FINANCE_INVALID');
  return Object.freeze({currency:'MXN',policyVersion:input.policyVersion,
    fulfillment:input.fulfillment,...m});
}

/**
 * Only a proposal from a verified TEST capture. It does not call Stripe and
 * it DOES NOT turn client-supplied "verified" into trustworthy payment proof.
 * Nothing is earned/withdrawable at capture: all allocations remain pending
 * until fulfillment, dispute, refund, and settlement gates are implemented.
 */
export function proposeCaptureJournal({orderId,restaurantId,driverId=null,snapshot,evidence}={}) {
  if(!positiveUuid(orderId)||!positiveUuid(restaurantId))
    throw new FinanceError('ACTOR_ID_INVALID');
  const m=validateFinancialSnapshot(snapshot);
  // A courier need not be selected at checkout. Capture always holds the
  // delivery allocation centrally; only a future verified M2 fulfillment
  // event may release it into a specific courier's wallet.
  if(driverId!==null&&!positiveUuid(driverId))
    throw new FinanceError('DRIVER_ID_INVALID');
  if(!evidence||evidence.sourceSystem!=='stripe_test'||
     evidence.kind!=='capture_verified'||
     typeof evidence.eventId!=='string'||
     !/^[A-Za-z0-9_.:-]{8,160}$/.test(evidence.eventId))
    throw new FinanceError('EVIDENCE_INVALID');
  const canonical=[orderId.toLowerCase(),restaurantId.toLowerCase(),
    driverId?.toLowerCase()??'',evidence.sourceSystem,evidence.eventId,
    m.policyVersion,m.fulfillment,...moneyFields.map(k=>m[k].toString())].join('|');
  const lines=[
    {accountCode:'asset.stripe_test_clearing',side:'debit',amountMinor:m.totalMinor.toString()},
    ...(m.merchantPayableMinor>0n?[{accountCode:'liability.merchant_pending',
      partyId:restaurantId.toLowerCase(),side:'credit',amountMinor:m.merchantPayableMinor.toString()}]:[]),
    ...(m.driverPayableMinor>0n?[{accountCode:'liability.driver_held',
      side:'credit',amountMinor:m.driverPayableMinor.toString()}]:[]),
    ...(m.platformGrossMinor>0n?[{accountCode:'liability.platform_pending',
      side:'credit',amountMinor:m.platformGrossMinor.toString()}]:[])
  ];
  const debit=lines.filter(l=>l.side==='debit').map(l=>BigInt(l.amountMinor)).reduce(add,0n);
  const credit=lines.filter(l=>l.side==='credit').map(l=>BigInt(l.amountMinor)).reduce(add,0n);
  if(debit!==credit||lines.length<2)throw new FinanceError('JOURNAL_UNBALANCED');
  return Object.freeze({
    orderId:orderId.toLowerCase(),kind:'capture',
    sourceSystem:'stripe_test',sourceEventId:evidence.eventId,
    snapshotHash:hash(canonical),currency:'MXN',
    lines:Object.freeze(lines.map(line=>Object.freeze(line)))
  });
}
