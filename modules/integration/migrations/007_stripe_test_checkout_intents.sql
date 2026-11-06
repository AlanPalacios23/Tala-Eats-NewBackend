-- M11 LAB8: recoverable Stripe TEST checkout intent distinct from cash saga.
-- Only disposable integration databases. No LIVE PSP credentials.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_integration_v2_test',
                                'tala_integration_v2_lab') THEN
  RAISE EXCEPTION 'M11_LAB_ONLY';
 END IF;
 IF to_regclass('tala_integration_v2.inventory_checkout_intents') IS NULL
  THEN RAISE EXCEPTION 'M11_LAB6_REQUIRED';
 END IF;
END $guard$;
CREATE TABLE tala_integration_v2.stripe_test_checkout_intents (
 intent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 m4_customer_id uuid NOT NULL,
 m1_buyer_id uuid NOT NULL,
 idempotency_key text NOT NULL
  CHECK(length(idempotency_key) BETWEEN 16 AND 128),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 store_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 m1_order_id uuid UNIQUE,
 m8_payment_id uuid UNIQUE,
 state text NOT NULL DEFAULT 'started'
  CHECK(state IN ('started','reserved','order_created',
                  'payment_created','verified','review')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(m1_buyer_id,idempotency_key),
 CHECK (state<>'verified' OR
   (m1_order_id IS NOT NULL AND m8_payment_id IS NOT NULL))
);
CREATE INDEX ix_m11_stripe_intent_incomplete
 ON tala_integration_v2.stripe_test_checkout_intents(state,created_at)
 WHERE state<>'verified';
CREATE TABLE tala_integration_v2.stripe_test_intent_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 intent_id uuid NOT NULL
  REFERENCES tala_integration_v2.stripe_test_checkout_intents(intent_id),
 event_type text NOT NULL CHECK(event_type IN
  ('stripe.started','stripe.reserved','stripe.order_created',
   'stripe.payment_created','stripe.verified','stripe.review')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(intent_id,event_type)
);
CREATE TRIGGER trg_m11_stripe_intent_events_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.stripe_test_intent_events
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();
COMMIT;
