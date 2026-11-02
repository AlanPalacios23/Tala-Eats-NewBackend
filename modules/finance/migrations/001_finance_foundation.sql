-- M3 standalone lab schema: NO foreign keys into M1/M2 and NO LIVE access.
-- Apply only on disposable tala_finance_v2_lab / tala_finance_v2_test.
BEGIN;
DO $guard$
BEGIN
  IF current_database() NOT IN ('tala_finance_v2_lab','tala_finance_v2_test') THEN
    RAISE EXCEPTION 'FINANCE_LAB_ONLY';
  END IF;
END
$guard$;
CREATE SCHEMA tala_finance_v2;

-- One complete append-only transaction per immutable row: no orphaned
-- journal headers or half-written postings. All amounts are decimal strings
-- representing nonnegative BIGINT centavos, never JSON floating point.
CREATE FUNCTION tala_finance_v2.valid_lines(lines jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  line jsonb;
  code text;
  side text;
  seen text[] := ARRAY[]::text[];
  amount_minor numeric;
  debit numeric := 0;
  credit numeric := 0;
  debit_lines integer := 0;
  credit_lines integer := 0;
BEGIN
  IF lines IS NULL OR jsonb_typeof(lines)<>'array'
    OR jsonb_array_length(lines)<2 OR jsonb_array_length(lines)>4 THEN
    RETURN false;
  END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(lines)
  LOOP
    IF jsonb_typeof(line)<>'object'
      OR jsonb_typeof(line->'amountMinor')<>'string'
      OR (line->>'amountMinor') !~ '^[1-9][0-9]{0,12}$'
      OR jsonb_typeof(line->'accountCode')<>'string'
      OR jsonb_typeof(line->'side')<>'string' THEN
      RETURN false;
    END IF;
    amount_minor := (line->>'amountMinor')::numeric;
    IF amount_minor>1000000000000 THEN RETURN false; END IF;
    code := line->>'accountCode';
    side := line->>'side';
    IF code=ANY(seen) THEN RETURN false; END IF;
    seen:=array_append(seen,code);
    IF code='asset.stripe_test_clearing' THEN
      IF side<>'debit' OR line ? 'partyId' THEN RETURN false; END IF;
      debit:=debit+amount_minor;
      debit_lines:=debit_lines+1;
    ELSIF code IN ('liability.merchant_payable','liability.driver_payable') THEN
      IF side<>'credit' OR (line->>'partyId') IS NULL
        OR (line->>'partyId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN false;
      END IF;
      credit:=credit+amount_minor;
      credit_lines:=credit_lines+1;
    ELSIF code='income.platform_gross' THEN
      IF side<>'credit' OR line ? 'partyId' THEN RETURN false; END IF;
      credit:=credit+amount_minor;
      credit_lines:=credit_lines+1;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN debit_lines=1 AND credit_lines>=1 AND debit=credit
    AND debit>0 AND debit<=1000000000000;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$fn$;

CREATE TABLE tala_finance_v2.journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind='capture'),
  source_system text NOT NULL CHECK (source_system='stripe_test'),
  source_event_id text NOT NULL
    CHECK (source_event_id ~ '^[A-Za-z0-9_.:-]{8,160}$'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  currency text NOT NULL DEFAULT 'MXN' CHECK (currency='MXN'),
  lines jsonb NOT NULL CHECK (tala_finance_v2.valid_lines(lines)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (order_id,kind), -- never double-capture one order
  UNIQUE (source_system,source_event_id) -- never consume the same provider event twice
);
CREATE INDEX ix_finance_journals_created ON tala_finance_v2.journals(created_at,id);
CREATE INDEX ix_finance_journals_order ON tala_finance_v2.journals(order_id);

CREATE FUNCTION tala_finance_v2.prevent_journal_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'FINANCE_JOURNAL_IMMUTABLE';
END
$fn$;
CREATE TRIGGER trg_finance_journals_append_only
  BEFORE UPDATE OR DELETE ON tala_finance_v2.journals
  FOR EACH ROW EXECUTE FUNCTION tala_finance_v2.prevent_journal_mutation();

CREATE VIEW tala_finance_v2.postings AS
SELECT j.id AS journal_id,j.order_id,j.created_at,j.currency,
  p.line->>'accountCode' AS account_code,
  p.line->>'partyId' AS party_id,
  p.line->>'side' AS side,
  (p.line->>'amountMinor')::bigint AS amount_minor
FROM tala_finance_v2.journals j
CROSS JOIN LATERAL jsonb_array_elements(j.lines) AS p(line);

-- No grants, webhook endpoints, payout jobs or connections to production.
COMMIT;
