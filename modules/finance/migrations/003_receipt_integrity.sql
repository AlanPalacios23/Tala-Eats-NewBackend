-- M3 LAB1.1: enforce that a receipt can never reference a journal or
-- PaymentIntent belonging to a different order, even via direct SQL.
-- Schema-local and disposable database only. Apply after 001, 002.
BEGIN;
DO $gate$
BEGIN
  IF current_database() NOT IN ('tala_finance_v2_test','tala_finance_v2_lab') THEN
    RAISE EXCEPTION 'FINANCE_LAB_ONLY';
  END IF;
  IF to_regclass('tala_finance_v2.test_intents') IS NULL
     OR to_regclass('tala_finance_v2.stripe_test_receipts') IS NULL
     OR to_regclass('tala_finance_v2.journals') IS NULL THEN
    RAISE EXCEPTION 'FINANCE_001_002_REQUIRED';
  END IF;
END
$gate$;

ALTER TABLE tala_finance_v2.test_intents
  ADD CONSTRAINT ux_m3_intent_order_pi UNIQUE (order_id,payment_intent_id);
ALTER TABLE tala_finance_v2.journals
  ADD CONSTRAINT ux_m3_journal_order_event UNIQUE (id,order_id,source_event_id);

ALTER TABLE tala_finance_v2.stripe_test_receipts
  ADD CONSTRAINT fk_m3_receipt_intent_same_order
    FOREIGN KEY (order_id,payment_intent_id)
    REFERENCES tala_finance_v2.test_intents(order_id,payment_intent_id),
  ADD CONSTRAINT fk_m3_receipt_journal_same_order_event
    FOREIGN KEY (journal_id,order_id,event_id)
    REFERENCES tala_finance_v2.journals(id,order_id,source_event_id);

COMMIT;
