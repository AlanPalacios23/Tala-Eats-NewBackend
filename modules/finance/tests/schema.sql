-- This script is intentionally executable only in disposable M3 test DB.
\set ON_ERROR_STOP on
BEGIN;
DO $gate$
BEGIN
  IF current_database()<>'tala_finance_v2_test' THEN
    RAISE EXCEPTION 'SCHEMA_TEST_DATABASE_FORBIDDEN';
  END IF;
END
$gate$;
INSERT INTO tala_finance_v2.journals
(order_id,kind,source_system,source_event_id,snapshot_hash,lines)
VALUES (
 '11111111-1111-4111-8111-111111111111','capture','stripe_test',
 'evt_test_finance_100',repeat('a',64),
 '[{"accountCode":"asset.stripe_test_clearing","side":"debit","amountMinor":"100"},
   {"accountCode":"liability.merchant_pending","partyId":"22222222-2222-4222-8222-222222222222","side":"credit","amountMinor":"80"},
   {"accountCode":"liability.platform_pending","side":"credit","amountMinor":"20"}]'::jsonb
);
DO $test$
BEGIN
  IF (SELECT sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END)
      FROM tala_finance_v2.postings)<>0 THEN
    RAISE EXCEPTION 'POSTINGS_NOT_BALANCED';
  END IF;
END
$test$;
DO $test$
BEGIN
  BEGIN
    INSERT INTO tala_finance_v2.journals
      (order_id,kind,source_system,source_event_id,snapshot_hash,lines)
    VALUES('33333333-3333-4333-8333-333333333333','capture','stripe_test',
      'evt_test_finance_unbalanced',repeat('b',64),
      '[{"accountCode":"asset.stripe_test_clearing","side":"debit","amountMinor":"100"},
        {"accountCode":"liability.platform_pending","side":"credit","amountMinor":"99"}]'::jsonb);
    RAISE EXCEPTION 'UNBALANCED_JOURNAL_WAS_ACCEPTED';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO tala_finance_v2.journals
      (order_id,kind,source_system,source_event_id,snapshot_hash,lines)
    SELECT order_id,kind,source_system,'evt_test_finance_duplicate',snapshot_hash,lines
    FROM tala_finance_v2.journals LIMIT 1;
    RAISE EXCEPTION 'DUPLICATE_ORDER_WAS_ACCEPTED';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE tala_finance_v2.journals SET snapshot_hash=repeat('f',64);
    RAISE EXCEPTION 'MUTATION_WAS_ACCEPTED';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'FINANCE_JOURNAL_IMMUTABLE' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM tala_finance_v2.journals;
    RAISE EXCEPTION 'DELETE_WAS_ACCEPTED';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'FINANCE_JOURNAL_IMMUTABLE' THEN RAISE; END IF;
  END;
END
$test$;
COMMIT;
SELECT 'M3_FINANCE_SCHEMA_TESTS_PASS' AS result;
