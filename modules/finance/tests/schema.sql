-- M3 FINANZAS ONLY. Exercises schema functions in disposable test DB.
\set ON_ERROR_STOP on
BEGIN;
DO $gate$
BEGIN
  IF current_database()<>'tala_finance_v2_test' THEN
    RAISE EXCEPTION 'FINANCE_TEST_DB_FORBIDDEN';
  END IF;
END $gate$;

DO $test$
DECLARE
  s jsonb:='{"currency":"MXN","fulfillment":"pickup",
    "policyVersion":"finance-only-test","itemsMinor":"10000",
    "merchantCommissionMinor":"1500","merchantPayableMinor":"8500",
    "serviceFeeMinor":"700","deliveryFeeMinor":"0","driverPayableMinor":"0",
    "tipMinor":"0","totalMinor":"10700","platformGrossMinor":"2200"}'::jsonb;
  good jsonb:='[
    {"accountCode":"asset.external_clearing_pending","side":"debit","amountMinor":"10700"},
    {"accountCode":"liability.merchant_pending",
     "partyId":"22222222-2222-4222-8222-222222222222","side":"credit","amountMinor":"8500"},
    {"accountCode":"liability.platform_pending","side":"credit","amountMinor":"2200"}
  ]'::jsonb;
  merchant uuid:='22222222-2222-4222-8222-222222222222';
BEGIN
  IF NOT tala_finance_v2.valid_snapshot(s) THEN
    RAISE EXCEPTION 'VALID_FINANCE_SNAPSHOT_REJECTED';
  END IF;
  IF NOT tala_finance_v2.valid_held_lines(good,s,merchant) THEN
    RAISE EXCEPTION 'VALID_FINANCE_LINES_REJECTED';
  END IF;
  IF tala_finance_v2.valid_held_lines(
     jsonb_set(good,'{0,amountMinor}','"10701"'),s,merchant)
  THEN RAISE EXCEPTION 'UNBALANCED_JOURNAL_ACCEPTED'; END IF;
  IF tala_finance_v2.valid_held_lines(
     jsonb_set(good,'{1,partyId}','"33333333-3333-4333-8333-333333333333"'),s,merchant)
  THEN RAISE EXCEPTION 'CROSS_MERCHANT_LEDGER_ACCEPTED'; END IF;
  IF tala_finance_v2.valid_held_lines(
     jsonb_set(good,'{0,withdrawable}','true'::jsonb),s,merchant)
  THEN RAISE EXCEPTION 'WITHDRAWABLE_FLAG_ACCEPTED'; END IF;
  IF tala_finance_v2.valid_snapshot(
     jsonb_set(s,'{totalMinor}','"10701"'))
  THEN RAISE EXCEPTION 'BAD_TOTAL_ACCEPTED'; END IF;
  IF tala_finance_v2.valid_snapshot(
     s||'{"paymentProvider":"stripe"}'::jsonb)
  THEN RAISE EXCEPTION 'PAYMENT_PROVIDER_FIELD_ACCEPTED'; END IF;
  IF tala_finance_v2.valid_snapshot(
     jsonb_set(s,'{policyVersion}','123'::jsonb))
  THEN RAISE EXCEPTION 'NONSTRING_POLICY_VERSION_ACCEPTED'; END IF;
  IF tala_finance_v2.valid_held_lines(
     jsonb_set(good,'{1}',(good->1) - 'partyId'),s,merchant)
  THEN RAISE EXCEPTION 'MISSING_MERCHANT_PARTY_ACCEPTED'; END IF;
  INSERT INTO tala_finance_v2.journals
    (order_id,restaurant_id,event_key,snapshot_hash,snapshot,lines)
  VALUES('11111111-1111-4111-8111-111111111111',merchant,
    repeat('a',64),repeat('b',64),s,good);
  BEGIN
    INSERT INTO tala_finance_v2.journals
      (order_id,restaurant_id,event_key,snapshot_hash,snapshot,lines)
    VALUES('11111111-1111-4111-8111-111111111111',merchant,
      repeat('c',64),repeat('d',64),s,good);
    RAISE EXCEPTION 'DUPLICATE_ALLOCATION_ACCEPTED';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE tala_finance_v2.journals SET snapshot_hash=repeat('f',64)
      WHERE order_id='11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'MUTATION_ACCEPTED';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'FINANCE_JOURNAL_IMMUTABLE' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM tala_finance_v2.journals
      WHERE order_id='11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'DELETE_ACCEPTED';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'FINANCE_JOURNAL_IMMUTABLE' THEN RAISE; END IF;
  END;
END $test$;

DO $balances$
BEGIN
  IF (SELECT pending_minor FROM tala_finance_v2.merchant_pending_balances
      WHERE restaurant_id='22222222-2222-4222-8222-222222222222')<8500 THEN
    RAISE EXCEPTION 'PENDING_MERCHANT_BALANCE_NOT_DERIVED';
  END IF;
  IF EXISTS(SELECT 1 FROM tala_finance_v2.merchant_pending_balances
            WHERE available_minor<>0) THEN
    RAISE EXCEPTION 'FUNDS_AVAILABLE_WITHOUT_FULFILLMENT';
  END IF;
END $balances$;
COMMIT;
SELECT 'FINANCE_ONLY_SCHEMA_PASS' AS result;
