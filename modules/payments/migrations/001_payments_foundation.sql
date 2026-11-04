-- Tala Eats Core v2 / M8 Pagos. Isolated simulation LAB only.
-- Never run against a production/shared database or Stripe accounts.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_payments_v2_test','tala_payments_v2_lab') THEN
  RAISE EXCEPTION 'PAYMENTS_LAB_ONLY';
 END IF;
END $guard$;
CREATE SCHEMA tala_payments_v2;

CREATE TABLE tala_payments_v2.payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_ref uuid NOT NULL UNIQUE,
 customer_ref uuid NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 currency text NOT NULL DEFAULT 'MXN' CHECK(currency='MXN'),
 state text NOT NULL DEFAULT 'pending'
   CHECK(state IN ('pending','succeeded','failed','canceled')),
 provider text NOT NULL DEFAULT 'simulated_lab'
   CHECK(provider='simulated_lab'),
 provider_ref text UNIQUE,
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_m8_payments_customer ON tala_payments_v2.payments(customer_ref,created_at DESC);

CREATE TABLE tala_payments_v2.refunds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 payment_id uuid NOT NULL REFERENCES tala_payments_v2.payments(id),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 state text NOT NULL DEFAULT 'requested'
   CHECK(state IN ('requested','succeeded','failed')),
 provider_ref text UNIQUE,
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_m8_refunds_payment ON tala_payments_v2.refunds(payment_id,state);

CREATE TABLE tala_payments_v2.idempotency_receipts (
 actor_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 action text NOT NULL CHECK(length(action) BETWEEN 3 AND 64),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 result_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,operation_id)
);

-- Verified simulated gateway events. No original webhook payload or customer PII.
CREATE TABLE tala_payments_v2.provider_events (
 event_id uuid PRIMARY KEY,
 event_kind text NOT NULL CHECK(event_kind IN
   ('payment.succeeded','payment.failed','payment.canceled',
    'refund.succeeded','refund.failed')),
 payment_id uuid NOT NULL REFERENCES tala_payments_v2.payments(id),
 refund_id uuid REFERENCES tala_payments_v2.refunds(id),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 outcome text NOT NULL CHECK(outcome IN ('applied','noop')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((event_kind LIKE 'refund.%')=(refund_id IS NOT NULL))
);
CREATE INDEX ix_m8_events_payment ON tala_payments_v2.provider_events(payment_id,recorded_at);

-- Derived facts for a future integration with M3, never dispatched by LAB.
-- Every row carries an unmistakable simulated_lab source.
CREATE TABLE tala_payments_v2.verified_facts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 event_id uuid NOT NULL UNIQUE REFERENCES tala_payments_v2.provider_events(event_id),
 payment_id uuid NOT NULL REFERENCES tala_payments_v2.payments(id),
 refund_id uuid REFERENCES tala_payments_v2.refunds(id),
 fact_type text NOT NULL CHECK(fact_type IN
   ('FundsConfirmed.v1','ProviderRefundConfirmed.v1')),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 currency text NOT NULL DEFAULT 'MXN' CHECK(currency='MXN'),
 source text NOT NULL DEFAULT 'simulated_lab' CHECK(source='simulated_lab'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((fact_type='ProviderRefundConfirmed.v1')=(refund_id IS NOT NULL))
);
CREATE INDEX ix_m8_facts_payment ON tala_payments_v2.verified_facts(payment_id,created_at);

CREATE TABLE tala_payments_v2.audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK(length(action) BETWEEN 3 AND 80),
 entity_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION tala_payments_v2.reject_immutable_change()
RETURNS trigger LANGUAGE plpgsql AS $func$
BEGIN
 RAISE EXCEPTION 'PAYMENTS_IMMUTABLE' USING ERRCODE='23514';
END $func$;
CREATE TRIGGER trg_m8_events_immutable BEFORE UPDATE OR DELETE
 ON tala_payments_v2.provider_events FOR EACH ROW
 EXECUTE FUNCTION tala_payments_v2.reject_immutable_change();
CREATE TRIGGER trg_m8_facts_immutable BEFORE UPDATE OR DELETE
 ON tala_payments_v2.verified_facts FOR EACH ROW
 EXECUTE FUNCTION tala_payments_v2.reject_immutable_change();
CREATE TRIGGER trg_m8_audit_immutable BEFORE UPDATE OR DELETE
 ON tala_payments_v2.audit FOR EACH ROW
 EXECUTE FUNCTION tala_payments_v2.reject_immutable_change();
COMMIT;
