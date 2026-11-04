-- Tala Eats M8 LAB2. Stripe TEST only, isolated from LAB1 synthetic gateway.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_payments_v2_test','tala_payments_v2_lab') THEN
  RAISE EXCEPTION 'PAYMENTS_LAB_ONLY';
 END IF;
 IF to_regclass('tala_payments_v2.payments') IS NULL THEN
  RAISE EXCEPTION 'M8_MIGRATION_001_REQUIRED';
 END IF;
END $guard$;

-- The two provider types must never be confused.
ALTER TABLE tala_payments_v2.payments DROP CONSTRAINT payments_provider_check;
ALTER TABLE tala_payments_v2.payments ADD CONSTRAINT payments_provider_check
 CHECK(provider IN ('simulated_lab','stripe_test'));

-- Durable remote operation intents are written *before* a network call.
-- A 20h retry horizon prevents fresh remote writes after Stripe's
-- idempotency retention may expire (manual reconciliation thereafter).
CREATE TABLE tala_payments_v2.stripe_test_intents (
 payment_id uuid PRIMARY KEY REFERENCES tala_payments_v2.payments(id),
 idempotency_key text NOT NULL UNIQUE
   CHECK(idempotency_key ~ '^m8-pi-[0-9a-f-]{36}$'),
 stripe_intent_id text UNIQUE
   CHECK(stripe_intent_id IS NULL OR stripe_intent_id ~ '^pi_[A-Za-z0-9]+$'),
 operation_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_until timestamptz,
 attached_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((stripe_intent_id IS NULL)=(attached_at IS NULL))
);

CREATE TABLE tala_payments_v2.stripe_test_refunds (
 refund_id uuid PRIMARY KEY REFERENCES tala_payments_v2.refunds(id),
 idempotency_key text NOT NULL UNIQUE
   CHECK(idempotency_key ~ '^m8-re-[0-9a-f-]{36}$'),
 stripe_refund_id text UNIQUE
   CHECK(stripe_refund_id IS NULL OR stripe_refund_id ~ '^re_[A-Za-z0-9]+$'),
 operation_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_until timestamptz,
 attached_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((stripe_refund_id IS NULL)=(attached_at IS NULL))
);

-- Stripe uses opaque string IDs (evt_/pi_/re_), not LAB UUID identifiers.
CREATE TABLE tala_payments_v2.stripe_test_events (
 stripe_event_id text PRIMARY KEY CHECK(stripe_event_id ~ '^evt_[A-Za-z0-9]+$'),
 kind text NOT NULL CHECK(kind IN (
  'payment_intent.succeeded','payment_intent.canceled',
  'payment_intent.payment_failed','refund.created',
  'refund.updated','refund.failed')),
 payment_id uuid NOT NULL REFERENCES tala_payments_v2.payments(id),
 refund_id uuid REFERENCES tala_payments_v2.refunds(id),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 outcome text NOT NULL CHECK(outcome IN ('applied','noop')),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((kind LIKE 'refund.%')=(refund_id IS NOT NULL))
);
CREATE INDEX ix_m8_stripe_events_payment
 ON tala_payments_v2.stripe_test_events(payment_id,received_at);

-- TEST facts are never handed to M3. Keep separate from synthetic LAB facts,
-- and do not assert real collection, bank balance, or cash settlement.
CREATE TABLE tala_payments_v2.stripe_test_facts (
 stripe_event_id text PRIMARY KEY
  REFERENCES tala_payments_v2.stripe_test_events(stripe_event_id),
 payment_id uuid NOT NULL REFERENCES tala_payments_v2.payments(id),
 refund_id uuid REFERENCES tala_payments_v2.refunds(id),
 fact_type text NOT NULL CHECK(fact_type IN (
  'FundsConfirmed.v1','ProviderRefundConfirmed.v1')),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 currency text NOT NULL DEFAULT 'MXN' CHECK(currency='MXN'),
 source text NOT NULL DEFAULT 'stripe_test' CHECK(source='stripe_test'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((fact_type='ProviderRefundConfirmed.v1')=(refund_id IS NOT NULL))
);
CREATE TRIGGER trg_m8_stripe_events_immutable BEFORE UPDATE OR DELETE
 ON tala_payments_v2.stripe_test_events FOR EACH ROW
 EXECUTE FUNCTION tala_payments_v2.reject_immutable_change();
CREATE TRIGGER trg_m8_stripe_facts_immutable BEFORE UPDATE OR DELETE
 ON tala_payments_v2.stripe_test_facts FOR EACH ROW
 EXECUTE FUNCTION tala_payments_v2.reject_immutable_change();
COMMIT;
