-- M11 LAB6: durable checkout intent, request fingerprint, cross-DB recovery.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_integration_v2_test','tala_integration_v2_lab') THEN
  RAISE EXCEPTION 'M11_LAB_ONLY';
 END IF;
 IF to_regclass('tala_integration_v2.variant_catalog_links') IS NULL THEN
  RAISE EXCEPTION 'M11_MIGRATION_004_REQUIRED';
 END IF;
END $guard$;
CREATE TABLE tala_integration_v2.inventory_checkout_intents (
 intent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 buyer_m1_id uuid NOT NULL,
 idempotency_key text NOT NULL
  CHECK(length(idempotency_key) BETWEEN 16 AND 128),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 store_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'started'
  CHECK(state IN ('started','reserved','confirmed','released','review')),
 m1_order_id uuid UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(buyer_m1_id,idempotency_key),
 CHECK (state<>'confirmed' OR m1_order_id IS NOT NULL)
);
CREATE INDEX ix_m11_inventory_intent_pending
 ON tala_integration_v2.inventory_checkout_intents(state,created_at)
 WHERE state IN ('started','reserved','review');
CREATE TABLE tala_integration_v2.inventory_intent_events (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 intent_id uuid NOT NULL REFERENCES tala_integration_v2.inventory_checkout_intents(intent_id),
 event_type text NOT NULL CHECK(event_type IN
  ('intent.started','intent.reserved','intent.confirmed',
   'intent.released','intent.review')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(intent_id,event_type)
);
CREATE TRIGGER trg_m11_inventory_events_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.inventory_intent_events
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();
COMMIT;
