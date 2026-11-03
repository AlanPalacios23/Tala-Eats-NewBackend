/**
 * TALA EATS CORE v2 · Module 3 FINANZAS ONLY.
 * Accounting policy/contracts, not payment processing or payment evidence.
 * Entries are proposed from trusted INTERNAL LAB accounting facts.
 * No Stripe, cards, webhooks, payment creation, refunds or payouts.
 */
import {createHash} from 'node:crypto';

export class FinanceError extends Error {
  constructor(code){super(code);this.code=code;this.name='FinanceError';}
}
export const FINANCE_POLICY_SCHEMA='finance.held-allocation.v1';
export const MONEY_FIELDS=Object.freeze([
  'itemsMinor','merchantCommissionMinor','merchantPayableMinor','serviceFeeMinor',
  'deliveryFeeMinor','driverPayableMinor','tipMinor','totalMinor','platformGrossMinor'
]);
const EXPECTED_KEYS=['currency','policyVersion','fulfillment',...MONEY_FIELDS].sort();
const MAX_MINOR=1_000_000_000_000n;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMAND=/^[A-Za-z0-9_.:-]{16,128}$/;
const MONEY=/^(0|[1-9][0-9]{0,15})$/;
const sha256=value=>createHash('sha256').update(value).digest('hex');

export function requireId(value){
  if(typeof value!=='string'||!UUID.test(value))
    throw new FinanceError('FINANCE_ID_INVALID');
  return value.toLowerCase();
}
const minor=value=>{
  if(typeof value!=='string'||!MONEY.test(value))
    throw new FinanceError('FINANCE_MONEY_INVALID');
  const n=BigInt(value);
  if(n>MAX_MINOR)throw new FinanceError('FINANCE_MONEY_OUT_OF_RANGE');
  return n;
};

/** M3 validates a versioned financial snapshot; it does NOT choose prices. */
export function validateFinancialSnapshot(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||
    Object.keys(input).sort().join('|')!==EXPECTED_KEYS.join('|')||
    input.currency!=='MXN'||!['pickup','delivery'].includes(input.fulfillment)||
    typeof input.policyVersion!=='string'||
    !/^[A-Za-z0-9_.:-]{1,96}$/.test(input.policyVersion))
    throw new FinanceError('FINANCE_SNAPSHOT_INVALID');
  const m=Object.fromEntries(MONEY_FIELDS.map(k=>[k,minor(input[k])]));
  if(m.itemsMinor===0n||m.merchantCommissionMinor>=m.itemsMinor||
    m.merchantPayableMinor!==m.itemsMinor-m.merchantCommissionMinor)
    throw new FinanceError('FINANCE_MERCHANT_SHARE_INVALID');
  if(m.totalMinor!==m.itemsMinor+m.serviceFeeMinor+m.deliveryFeeMinor+m.tipMinor)
    throw new FinanceError('FINANCE_CUSTOMER_TOTAL_INVALID');
  if(m.merchantPayableMinor+m.driverPayableMinor+m.platformGrossMinor!==m.totalMinor)
    throw new FinanceError('FINANCE_ALLOCATION_INVALID');
  if(input.fulfillment==='pickup'&&
    (m.deliveryFeeMinor!==0n||m.driverPayableMinor!==0n||m.tipMinor!==0n))
    throw new FinanceError('FINANCE_PICKUP_INVALID');
  if(input.fulfillment==='delivery'&&
    (m.deliveryFeeMinor===0n||m.driverPayableMinor===0n))
    throw new FinanceError('FINANCE_DELIVERY_INVALID');
  return Object.freeze({currency:'MXN',fulfillment:input.fulfillment,
    policyVersion:input.policyVersion,
    ...Object.fromEntries(MONEY_FIELDS.map(k=>[k,m[k].toString()]))});
}

export function financeSnapshotHash(orderId,restaurantId,snapshot){
  const id=requireId(orderId),merchant=requireId(restaurantId);
  const s=validateFinancialSnapshot(snapshot);
  return sha256(JSON.stringify([FINANCE_POLICY_SCHEMA,id,merchant,
    s.policyVersion,s.fulfillment,...MONEY_FIELDS.map(k=>s[k])]));
}

/**
 * All value remains HELD/PENDING. It is NOT available for withdrawal.
 * Delivery earnings are unassigned here: selecting a courier belongs to M2.
 */
export function proposeHeldAllocation({orderId,restaurantId,snapshot,commandKey}={}){
  const order=requireId(orderId),merchant=requireId(restaurantId);
  if(typeof commandKey!=='string'||!COMMAND.test(commandKey))
    throw new FinanceError('FINANCE_COMMAND_INVALID');
  const s=validateFinancialSnapshot(snapshot);
  const lines=[
    {accountCode:'asset.external_clearing_pending',side:'debit',amountMinor:s.totalMinor},
    {accountCode:'liability.merchant_pending',partyId:merchant,
      side:'credit',amountMinor:s.merchantPayableMinor},
    ...(s.driverPayableMinor!=='0'?[{accountCode:'liability.delivery_held',
      side:'credit',amountMinor:s.driverPayableMinor}]:[]),
    ...(s.platformGrossMinor!=='0'?[{accountCode:'liability.platform_pending',
      side:'credit',amountMinor:s.platformGrossMinor}]:[])
  ];
  const debit=lines.filter(l=>l.side==='debit')
    .reduce((sum,line)=>sum+BigInt(line.amountMinor),0n);
  const credit=lines.filter(l=>l.side==='credit')
    .reduce((sum,line)=>sum+BigInt(line.amountMinor),0n);
  if(debit!==credit||debit<=0n)throw new FinanceError('FINANCE_JOURNAL_UNBALANCED');
  return Object.freeze({
    orderId:order,restaurantId:merchant,kind:'allocation_held',
    eventKey:sha256(FINANCE_POLICY_SCHEMA+'|'+order+'|'+commandKey),
    snapshotHash:financeSnapshotHash(order,merchant,s),
    currency:'MXN',snapshot:s,
    lines:Object.freeze(lines.map(line=>Object.freeze(line)))
  });
}
