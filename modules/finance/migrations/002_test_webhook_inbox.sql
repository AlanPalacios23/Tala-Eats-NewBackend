-- M3 LAB1 durable TEST intent registry and signed provider event receipts.
-- Must follow 001 and ONLY run on isolated disposable M3 test/lab database.
BEGIN;
DO $guard$
BEGIN
  IF current_database() NOT IN ('tala_finance_v2_lab','tala_finance_v2_test') THEN
    RAISE EXCEPTION 'FINANCE_LAB_ONLY';
  END IF;
  IF to_regclass('tala_finance_v2.journals') IS NULL THEN
    RAISE EXCEPTION 'FINANCE_001_REQUIRED';
  END IF;
END
$guard$;

CREATE TABLE tala_finance_v2.test_intents (
  order_id uuid PRIMARY KEY,
  restaurant_id uuid NOT NULL,
  driver_id uuid,
  payment_intent_id text NOT NULL UNIQUE
    CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9_]{6,150}$'),
  snapshot jsonb NOT NULL,
  contract_hash text NOT NULL CHECK (contract_hash ~ '^[a-f0-9]{64}$'),
  expected_minor bigint NOT NULL CHECK (expected_minor BETWEEN 1 AND 1000000000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(snapshot)='object')
);

CREATE TABLE tala_finance_v2.stripe_test_receipts (
  event_id text PRIMARY KEY CHECK (event_id ~ '^evt_[A-Za-z0-9_]{6,150}$'),
  payment_intent_id text NOT NULL REFERENCES tala_finance_v2.test_intents(payment_intent_id),
  order_id uuid NOT NULL REFERENCES tala_finance_v2.test_intents(order_id),
  journal_id uuid NOT NULL UNIQUE REFERENCES tala_finance_v2.journals(id),
  raw_hash text NOT NULL CHECK (raw_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Both registries are append-only: reconciliation and corrections will use
-- explicit compensating entries in later labs, never in-place edits.
CREATE TRIGGER trg_m3_test_intents_immutable
  BEFORE UPDATE OR DELETE ON tala_finance_v2.test_intents
  FOR EACH ROW EXECUTE FUNCTION tala_finance_v2.prevent_journal_mutation();
CREATE TRIGGER trg_m3_stripe_receipts_immutable
  BEFORE UPDATE OR DELETE ON tala_finance_v2.stripe_test_receipts
  FOR EACH ROW EXECUTE FUNCTION tala_finance_v2.prevent_journal_mutation();

COMMIT;
