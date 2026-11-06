-- M3 LAB3: driver-specific HELD auxiliary ledger, without payout authority.
-- A claim references one still-held delivery allocation and adds NO money.
-- Only disposable finance lab databases; apply after migrations 001 and 002.
BEGIN;
DO $guard$
BEGIN
  IF current_database() NOT IN ('tala_finance_v2_test','tala_finance_v2_lab') THEN
    RAISE EXCEPTION 'FINANCE_LAB_ONLY';
  END IF;
  IF to_regclass('tala_finance_v2.journals') IS NULL OR
     to_regclass('tala_finance_v2.held_reversals') IS NULL THEN
    RAISE EXCEPTION 'FINANCE_001_002_REQUIRED';
  END IF;
END $guard$;

CREATE TABLE tala_finance_v2.driver_held_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE,
  original_journal_id uuid NOT NULL UNIQUE,
  restaurant_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 1 AND 1000000000000),
  event_key text NOT NULL UNIQUE CHECK(event_key ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_finance_driver_claim_journal FOREIGN KEY
    (original_journal_id,order_id,restaurant_id)
    REFERENCES tala_finance_v2.journals (id,order_id,restaurant_id)
);
CREATE INDEX ix_finance_driver_claims_driver ON
  tala_finance_v2.driver_held_claims(driver_id,created_at,id);

CREATE FUNCTION tala_finance_v2.validate_driver_held_claim()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  original_row tala_finance_v2.journals%ROWTYPE;
BEGIN
  -- Serializes assignment against full reversal, both lock original journal.
  SELECT * INTO original_row FROM tala_finance_v2.journals
    WHERE id=NEW.original_journal_id FOR UPDATE;
  IF NOT FOUND OR original_row.order_id IS DISTINCT FROM NEW.order_id OR
    original_row.restaurant_id IS DISTINCT FROM NEW.restaurant_id OR
    original_row.kind<>'allocation_held' OR original_row.currency<>'MXN' OR
    original_row.snapshot->>'fulfillment'<>'delivery' OR
    (original_row.snapshot->>'driverPayableMinor')::numeric<>
      NEW.amount_minor::numeric OR
    EXISTS (SELECT 1 FROM tala_finance_v2.held_reversals
            WHERE original_journal_id=NEW.original_journal_id)
  THEN
    RAISE EXCEPTION 'FINANCE_DRIVER_CLAIM_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER trg_finance_driver_claim_check
  BEFORE INSERT ON tala_finance_v2.driver_held_claims
  FOR EACH ROW EXECUTE FUNCTION tala_finance_v2.validate_driver_held_claim();

CREATE TRIGGER trg_finance_driver_claim_append_only
  BEFORE UPDATE OR DELETE ON tala_finance_v2.driver_held_claims
  FOR EACH ROW EXECUTE FUNCTION tala_finance_v2.reject_journal_mutation();

-- A reversal causes the previously claimed HELD amount to disappear from
-- outstanding driver balances. It never becomes a payout.
CREATE VIEW tala_finance_v2.driver_held_balances AS
SELECT c.driver_id,
  sum(CASE WHEN r.id IS NULL THEN c.amount_minor ELSE 0 END)::bigint AS pending_minor,
  0::bigint AS available_minor
FROM tala_finance_v2.driver_held_claims c
LEFT JOIN tala_finance_v2.held_reversals r
  ON r.original_journal_id=c.original_journal_id
GROUP BY c.driver_id;
COMMIT;
