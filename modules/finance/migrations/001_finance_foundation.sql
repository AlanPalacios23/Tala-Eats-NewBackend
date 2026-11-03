-- M3 FINANZAS ONLY: provider-neutral, append-only financial allocation.
-- Only disposable tala_finance_v2_test or tala_finance_v2_lab. No M1/M2 FK.
-- No Stripe, PaymentIntent, webhook, checkout, refunds, transfers or payouts.
BEGIN;
DO $guard$
BEGIN
  IF current_database() NOT IN ('tala_finance_v2_lab','tala_finance_v2_test') THEN
    RAISE EXCEPTION 'FINANCE_LAB_ONLY';
  END IF;
END
$guard$;
CREATE SCHEMA tala_finance_v2;

CREATE FUNCTION tala_finance_v2.valid_snapshot(s jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  key text;
  money numeric;
  items numeric;
  commission numeric;
  merchant numeric;
  service numeric;
  delivery numeric;
  driver numeric;
  tip numeric;
  total numeric;
  platform numeric;
BEGIN
  IF s IS NULL OR jsonb_typeof(s) IS DISTINCT FROM 'object' OR
     (s - ARRAY['currency','fulfillment','policyVersion','itemsMinor',
       'merchantCommissionMinor','merchantPayableMinor','serviceFeeMinor',
       'deliveryFeeMinor','driverPayableMinor','tipMinor','totalMinor',
       'platformGrossMinor'])<>'{}'::jsonb OR
     (SELECT count(*) FROM jsonb_object_keys(s))<>12 OR
     s->>'currency'<>'MXN' OR
     s->>'fulfillment' NOT IN ('pickup','delivery') OR
     (s->>'policyVersion') !~ '^[A-Za-z0-9_.:-]{1,96}$' THEN
    RETURN false;
  END IF;
  FOREACH key IN ARRAY ARRAY['itemsMinor','merchantCommissionMinor',
    'merchantPayableMinor','serviceFeeMinor','deliveryFeeMinor',
    'driverPayableMinor','tipMinor','totalMinor','platformGrossMinor']
  LOOP
    IF jsonb_typeof(s->key) IS DISTINCT FROM 'string'
      OR (s->>key) !~ '^(0|[1-9][0-9]{0,15})$' THEN RETURN false; END IF;
    money:=(s->>key)::numeric;
    IF money>1000000000000 THEN RETURN false; END IF;
  END LOOP;
  items:=(s->>'itemsMinor')::numeric;
  commission:=(s->>'merchantCommissionMinor')::numeric;
  merchant:=(s->>'merchantPayableMinor')::numeric;
  service:=(s->>'serviceFeeMinor')::numeric;
  delivery:=(s->>'deliveryFeeMinor')::numeric;
  driver:=(s->>'driverPayableMinor')::numeric;
  tip:=(s->>'tipMinor')::numeric;
  total:=(s->>'totalMinor')::numeric;
  platform:=(s->>'platformGrossMinor')::numeric;
  IF items<=0 OR commission>=items OR merchant<>items-commission
    OR total<>items+service+delivery+tip
    OR total<>merchant+driver+platform THEN RETURN false; END IF;
  IF s->>'fulfillment'='pickup'
     AND (delivery<>0 OR driver<>0 OR tip<>0) THEN RETURN false; END IF;
  IF s->>'fulfillment'='delivery'
     AND (delivery=0 OR driver=0) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$fn$;

CREATE FUNCTION tala_finance_v2.valid_held_lines(lines jsonb,s jsonb,merchant uuid)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  line jsonb;
  code text;
  side text;
  amount numeric;
  debit numeric:=0;
  credit numeric:=0;
  seen text[]:=ARRAY[]::text[];
  merchant_count integer:=0;
  delivery_count integer:=0;
  platform_count integer:=0;
  clearing_count integer:=0;
BEGIN
  IF NOT tala_finance_v2.valid_snapshot(s)
    OR lines IS NULL OR jsonb_typeof(lines) IS DISTINCT FROM 'array'
    OR jsonb_array_length(lines) NOT BETWEEN 2 AND 4 THEN RETURN false; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(lines)
  LOOP
    IF jsonb_typeof(line) IS DISTINCT FROM 'object' OR
      (line - ARRAY['accountCode','side','amountMinor','partyId'])<>'{}'::jsonb OR
      jsonb_typeof(line->'accountCode') IS DISTINCT FROM 'string' OR
      jsonb_typeof(line->'side') IS DISTINCT FROM 'string' OR
      jsonb_typeof(line->'amountMinor') IS DISTINCT FROM 'string' OR
      (line->>'amountMinor') !~ '^[1-9][0-9]{0,15}$' THEN RETURN false; END IF;
    code:=line->>'accountCode';
    side:=line->>'side';
    amount:=(line->>'amountMinor')::numeric;
    IF code=ANY(seen) OR amount>1000000000000 THEN RETURN false; END IF;
    seen:=array_append(seen,code);
    IF code='asset.external_clearing_pending' THEN
      IF side<>'debit' OR line ? 'partyId'
        OR amount<>(s->>'totalMinor')::numeric THEN RETURN false; END IF;
      clearing_count:=clearing_count+1;
    ELSIF code='liability.merchant_pending' THEN
      IF side<>'credit' OR (line->>'partyId') IS DISTINCT FROM merchant::text
        OR amount<>(s->>'merchantPayableMinor')::numeric THEN RETURN false; END IF;
      merchant_count:=merchant_count+1;
    ELSIF code='liability.delivery_held' THEN
      IF side<>'credit' OR line ? 'partyId'
        OR amount<>(s->>'driverPayableMinor')::numeric THEN RETURN false; END IF;
      delivery_count:=delivery_count+1;
    ELSIF code='liability.platform_pending' THEN
      IF side<>'credit' OR line ? 'partyId'
        OR amount<>(s->>'platformGrossMinor')::numeric THEN RETURN false; END IF;
      platform_count:=platform_count+1;
    ELSE
      RETURN false;
    END IF;
    IF side='debit' THEN debit:=debit+amount;
    ELSIF side='credit' THEN credit:=credit+amount;
    ELSE RETURN false; END IF;
  END LOOP;
  RETURN clearing_count=1 AND merchant_count=1
    AND delivery_count=CASE WHEN (s->>'driverPayableMinor')::numeric>0 THEN 1 ELSE 0 END
    AND platform_count=CASE WHEN (s->>'platformGrossMinor')::numeric>0 THEN 1 ELSE 0 END
    AND debit=credit AND debit=(s->>'totalMinor')::numeric;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$fn$;

CREATE TABLE tala_finance_v2.journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  restaurant_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'allocation_held'
    CHECK (kind='allocation_held'),
  event_key text NOT NULL UNIQUE CHECK(event_key ~ '^[a-f0-9]{64}$'),
  snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
  currency text NOT NULL DEFAULT 'MXN' CHECK(currency='MXN'),
  snapshot jsonb NOT NULL,
  lines jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(order_id,kind),
  CHECK(tala_finance_v2.valid_held_lines(lines,snapshot,restaurant_id))
);
CREATE INDEX ix_m3_journal_order ON tala_finance_v2.journals(order_id);
CREATE INDEX ix_m3_journal_recorded ON tala_finance_v2.journals(recorded_at,id);

CREATE FUNCTION tala_finance_v2.reject_journal_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'FINANCE_JOURNAL_IMMUTABLE';
END $fn$;
CREATE TRIGGER trg_m3_journal_append_only
 BEFORE UPDATE OR DELETE ON tala_finance_v2.journals
 FOR EACH ROW EXECUTE FUNCTION tala_finance_v2.reject_journal_mutation();

CREATE VIEW tala_finance_v2.postings AS
SELECT j.id AS journal_id,j.order_id,j.restaurant_id,j.recorded_at,
 p.line->>'accountCode' AS account_code,
 p.line->>'partyId' AS party_id,
 p.line->>'side' AS side,
 (p.line->>'amountMinor')::bigint AS amount_minor
FROM tala_finance_v2.journals j
CROSS JOIN LATERAL jsonb_array_elements(j.lines) AS p(line);

-- Internal accounting projections only. "Available" is intentionally ZERO:
-- fulfillment, payout eligibility and cash reconciliation are not integrated.
CREATE VIEW tala_finance_v2.merchant_pending_balances AS
SELECT p.party_id::uuid AS restaurant_id,
 sum(p.amount_minor)::bigint AS pending_minor,
 0::bigint AS available_minor
FROM tala_finance_v2.postings p
WHERE p.account_code='liability.merchant_pending'
GROUP BY p.party_id;

CREATE VIEW tala_finance_v2.held_liabilities AS
SELECT account_code,sum(amount_minor)::bigint AS held_minor
FROM tala_finance_v2.postings
WHERE side='credit'
GROUP BY account_code;

COMMIT;
