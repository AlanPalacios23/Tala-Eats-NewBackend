/**
 * Price snapshot: amounts are BIGINT CENTAVOS, never floating point.
 * Quoted at checkout as integer MXN centavos. This file does not
 * independently enable LIVE payments, settlements, or writes.
 * Commercial contract approved 2026-11-06: 17% merchant, 7% customer,
 * zero tip commission. No fixed $25 service-fee cap.
 */
export const PRICING_POLICY_VERSION = 'pilot-2026-11-v3-17pct-7pct-uncapped';

type Line = { unitMinor: bigint; quantity: number };
export type QuoteInput = {
  lines: readonly Line[];
  fulfillment: 'pickup' | 'delivery';
  deliveryFeeMinor: bigint;
  driverBaseMinor: bigint;
  tipMinor: bigint;
};
export type Quote = {
  policyVersion: string;
  itemsMinor: bigint;
  merchantCommissionMinor: bigint;
  merchantPayableMinor: bigint;
  serviceFeeMinor: bigint;
  deliveryFeeMinor: bigint;
  driverPayableMinor: bigint;
  tipMinor: bigint;
  totalMinor: bigint;
  platformGrossMinor: bigint;
};

const validMinor = (n: bigint) => n >= 0n && n <= 100_000_000_00n;
const bps = (base: bigint, pct: bigint) => (base * pct + 5_000n) / 10_000n;

export function quoteOrder(input: QuoteInput): Quote {
  if (input.lines.length === 0 || input.lines.length > 100) throw Error('LINES_INVALID');
  let items = 0n;
  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 1000
      || !validMinor(line.unitMinor)) throw Error('LINE_INVALID');
    items += line.unitMinor * BigInt(line.quantity);
  }
  if (!validMinor(items) || items === 0n
    || !validMinor(input.deliveryFeeMinor) || !validMinor(input.driverBaseMinor)
    || !validMinor(input.tipMinor)) throw Error('MONEY_INVALID');
  if (input.fulfillment === 'pickup' &&
    (input.deliveryFeeMinor !== 0n || input.driverBaseMinor !== 0n || input.tipMinor !== 0n)) {
    throw Error('PICKUP_LOGISTICS_INVALID');
  }
  if (input.fulfillment === 'delivery' &&
    (input.deliveryFeeMinor === 0n || input.driverBaseMinor === 0n)) {
    throw Error('DELIVERY_LOGISTICS_INVALID');
  }
  const commission = bps(items, 1_700n);
  const service = bps(items, 700n);
  const merchant = items - commission;
  const driver = input.fulfillment === 'delivery'
    ? input.driverBaseMinor + input.tipMinor : 0n;
  const total = items + service + input.deliveryFeeMinor + input.tipMinor;
  const platform = total - merchant - driver;
  if (!validMinor(total) || !validMinor(driver) || !validMinor(platform)) throw Error('TOTAL_INVALID');
  return {
    policyVersion: PRICING_POLICY_VERSION,
    itemsMinor: items,
    merchantCommissionMinor: commission,
    merchantPayableMinor: merchant,
    serviceFeeMinor: service,
    deliveryFeeMinor: input.deliveryFeeMinor,
    driverPayableMinor: driver,
    tipMinor: input.tipMinor,
    totalMinor: total,
    platformGrossMinor: platform
  };
}
