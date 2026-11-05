-- M3 FINANZAS: full compensating reversals for isolated held allocations.
-- No provider refund, no payout, no payment status, no net-new money.
-- Apply AFTER 001 in a disposable M3 lab database only.
BEGIN;
DO $gate$
BEGIN
  IF current_database() NOT IN ('tala_finance_v2_test','tala_finance_v2_lab') THEN
    RAISE EXCEPTION 'FINANCE_LAB_ONLY';
  END IF;
  IF to_regclass('tala_finance_v2.journals') IS NULL THEN
    RAISE EXCEPTION 'FINANCE_001_REQUIRED';
  END IF;
END $gate$;

ALTER TABLE tala_finance_v2.journals
  ADD CONSTRAINT uq_finance_journal_identity UNIQUE (id,order_id,restaurant_id);

CREATE FUNCTION tala_finance_v2.exact_reversal_lines(original jsonb, reversed jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  expected jsonb;
BEGIN
  IF original IS NULL OR reversed IS NULL
    OR jsonb_typeof(original) IS DISTINCT FROM 'array'
    OR jsonb_typeof(reversed) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  SELECT jsonb_agg(
    jsonb_set(p.line,'{side}',
      to_jsonb(CASE p.line->>'side'
        WHEN 'credit' THEN 'debit' WHEN 'debit' THEN 'credit'
        ELSE 'invalid' END)
    ) ORDER BY p.ordinal
  ) INTO expected
  FROM jsonb_array_elements(original) WITH ORDINALITY AS p(line,ordinal);
  RETURN expected=reversed;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $fn$;

CREATE TABLE tala_finance_v2.held_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_journal_id uuid NOT NULL UNIQUE,
  order_id uuid NOT NULL UNIQUE,
  restaurant_id uuid NOT NULL,
  event_key text NOT NULL UNIQUE CHECK(event_key ~ '^[a-f0-9]{64}$'),
  snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  currency text NOT NULL DEFAULT 'MXN' CHECK(currency='MXN'),
  lines jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_finance_reversal_identity FOREIGN KEY
    (original_journal_id,order_id,restaurant_id)
    REFERENCES tala_finance_v2.journals (id,order_id,restaurant_id)
);

CREATE FUNCTION tala_finance_v2.verify_held_reversal()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  original_row tala_finance_v2.journals%ROWTYPE;
BEGIN
  SELECT * INTO original_row FROM tala_finance_v2.journals
  WHERE id=NEW.original_journal_id FOR UPDATE;
  IF NOT FOUND OR original_row.order_id IS DISTINCT FROM NEW.order_id
    OR original_row.restaurant_id IS DISTINCT FROM NEW.restaurant_id
    OR original_row.kind<>'allocation_held'
    OR original_row.currency<>NEW.currency
    OR original_row.snapshot_hash<>NEW.snapshot_hash
    OR NOT tala_finance_v2.exact_reversal_lines(original_row.lines,NEW.lines) THEN
    RAISE EXCEPTION 'FINANCE_REVERSAL_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER trg_finance_validate_reversal
  BEFORE INSERT ON tala_finance_v2.held_reversals
  FOR EACH ROW EXECUTE FUNCTION tala_finance_v2.verify_held_reversal();
CREATE TRIGGER trg_finance_reversal_append_only
  BEFORE UPDATE OR DELETE ON tala_finance_v2.held_reversals
  FOR EACH ROW EXECUTE FUNCTION tala_finance_v2.reject_journal_mutation();

CREATE VIEW tala_finance_v2.reversal_postings AS
SELECT r.id AS reversal_id,r.original_journal_id,r.order_id,r.restaurant_id,
 r.recorded_at,
 p.line->>'accountCode' AS account_code,
 p.line->>'partyId' AS party_id,
 p.line->>'side' AS side,
 (p.line->>'amountMinor')::bigint AS amount_minor
FROM tala_finance_v2.held_reversals r
CROSS JOIN LATERAL jsonb_array_elements(r.lines) AS p(line);

-- A full reversal cancels the held accounting allocation, without
-- crediting money to a merchant wallet or authorizing a withdrawal.
CREATE OR REPLACE VIEW tala_finance_v2.merchant_pending_balances AS
WITH movements AS (
 SELECT party_id::uuid AS restaurant_id,amount_minor::numeric AS minor
 FROM tala_finance_v2.postings
 WHERE account_code='liability.merchant_pending'
 UNION ALL
 SELECT party_id::uuid AS restaurant_id,-amount_minor::numeric AS minor
 FROM tala_finance_v2.reversal_postings
 WHERE account_code='liability.merchant_pending'
)
SELECT restaurant_id,sum(minor)::bigint AS pending_minor,
 0::bigint AS available_minor
FROM movements GROUP BY restaurant_id;

CREATE OR REPLACE VIEW tala_finance_v2.held_liabilities AS
WITH movements AS (
 SELECT account_code,amount_minor::numeric AS minor FROM tala_finance_v2.postings
 WHERE side='credit'
 UNION ALL
 SELECT account_code,-amount_minor::numeric AS minor
 FROM tala_finance_v2.reversal_postings WHERE side='debit'
)
SELECT account_code,sum(minor)::bigint AS held_minor
FROM movements GROUP BY account_code;
COMMIT;
