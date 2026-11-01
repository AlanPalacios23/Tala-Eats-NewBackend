/**
 * TALA EATS CORE v2: pure, deterministic order lifecycle.
 * This is NOT a payment processor, stock reservation, or HTTP endpoint.
 * The authenticated application layer must validate actor ownership,
 * verify money with trusted sources, and commit state+events atomically.
 */
export type OrderStatus =
  | 'awaiting_payment' | 'received' | 'confirmed' | 'preparing'
  | 'ready' | 'assigned' | 'picked_up' | 'on_the_way'
  | 'delivered' | 'cancelled';

export type Fulfillment = 'pickup' | 'delivery';
export type PaymentMethod = 'cash' | 'stripe';
export type ActorRole = 'system' | 'customer' | 'merchant' | 'driver' | 'admin';

export type TransitionInput = {
  current: OrderStatus;
  target: OrderStatus;
  fulfillment: Fulfillment;
  paymentMethod: PaymentMethod;
  actor: ActorRole;
  /** Verified by backend, never taken from a browser or an app field. */
  paymentVerified?: boolean;
  /** Confirmed in same transaction as cancellation/stock+money compensation. */
  cancellationCleared?: boolean;
  /** One-time proof checked by the trusted backend. */
  deliveryPinVerified?: boolean;
  pickupProofVerified?: boolean;
  /** Internal dispatcher decision after transactional release of old claim. */
  reassignmentAuthorized?: boolean;
};

export class OrderTransitionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'OrderTransitionError';
  }
}

const rules: Record<OrderStatus, Partial<Record<OrderStatus, readonly ActorRole[]>>> = {
  awaiting_payment: { received: ['system'], cancelled: ['system', 'admin'] },
  received: { confirmed: ['merchant'], cancelled: ['customer', 'merchant', 'system', 'admin'] },
  confirmed: { preparing: ['merchant'], cancelled: ['merchant', 'system', 'admin'] },
  preparing: { ready: ['merchant'], cancelled: ['system', 'admin'] },
  ready: { assigned: ['system'], delivered: ['merchant'], cancelled: ['system', 'admin'] },
  assigned: { picked_up: ['driver'], ready: ['system'] },
  picked_up: { on_the_way: ['driver'] },
  on_the_way: { delivered: ['driver'] },
  delivered: {},
  cancelled: {}
};

export function transitionOrder(input: TransitionInput): OrderStatus {
  const allowed = rules[input.current]?.[input.target];
  if (!allowed) throw new OrderTransitionError('TRANSITION_FORBIDDEN');
  if (!allowed.includes(input.actor)) throw new OrderTransitionError('ACTOR_FORBIDDEN');

  if (input.target === 'cancelled' && input.cancellationCleared !== true) {
    throw new OrderTransitionError('CANCELLATION_COMPENSATION_REQUIRED');
  }
  if (input.current === 'awaiting_payment' && input.target === 'received'
      && input.paymentMethod === 'stripe' && input.paymentVerified !== true) {
    throw new OrderTransitionError('PAYMENT_VERIFICATION_REQUIRED');
  }
  if (input.current === 'ready' && input.target === 'assigned'
      && input.fulfillment !== 'delivery') {
    throw new OrderTransitionError('PICKUP_HAS_NO_DRIVER');
  }
  if ((input.target === 'assigned' || input.current === 'assigned'
      || input.current === 'picked_up' || input.current === 'on_the_way')
      && input.fulfillment !== 'delivery') {
    throw new OrderTransitionError('DELIVERY_ONLY_TRANSITION');
  }
  if (input.current === 'assigned' && input.target === 'ready'
      && input.reassignmentAuthorized !== true) {
    throw new OrderTransitionError('REASSIGNMENT_PROOF_REQUIRED');
  }
  if (input.target === 'delivered') {
    if (input.paymentVerified !== true) {
      throw new OrderTransitionError('PAYMENT_VERIFICATION_REQUIRED');
    }
    if (input.fulfillment === 'pickup') {
      if (input.current !== 'ready' || input.pickupProofVerified !== true) {
        throw new OrderTransitionError('PICKUP_PROOF_REQUIRED');
      }
    } else if (input.current !== 'on_the_way' || input.deliveryPinVerified !== true) {
      throw new OrderTransitionError('DELIVERY_PIN_REQUIRED');
    }
  }
  return input.target;
}
