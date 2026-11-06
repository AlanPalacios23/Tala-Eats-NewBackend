-- Tala Eats Core v2 — M11 integration inbox, disposable LAB ONLY.
BEGIN;
DO $gate$
BEGIN
 IF current_database() NOT IN ('tala_integration_v2_test',
                                'tala_integration_v2_lab') THEN
  RAISE EXCEPTION 'M11_LAB_ONLY';
 END IF;
END $gate$;
CREATE SCHEMA tala_integration_v2;
CREATE TABLE tala_integration_v2.events(
 event_id uuid PRIMARY KEY,
 source text NOT NULL CHECK(source IN ('orders','restaurants','logistics')),
 kind text NOT NULL CHECK(kind IN
  ('orders.order_created','restaurants.order_ready','logistics.delivery_completed')),
 order_id uuid NOT NULL,
 merchant_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL,
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (
  (source='orders' AND kind='orders.order_created') OR
  (source='restaurants' AND kind='restaurants.order_ready') OR
  (source='logistics' AND kind='logistics.delivery_completed')
 )
);
CREATE INDEX ix_m11_event_order ON tala_integration_v2.events(order_id,created_at);
CREATE TABLE tala_integration_v2.deliveries(
 event_id uuid NOT NULL REFERENCES tala_integration_v2.events(event_id),
 consumer text NOT NULL CHECK(consumer IN ('notifications','logistics','analytics')),
 state text NOT NULL DEFAULT 'pending'
  CHECK(state IN ('pending','leased','delivered','dead')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 claim_id uuid,
 lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(event_id,consumer),
 CHECK((state='leased')=(claim_id IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX ix_m11_deliveries_due ON tala_integration_v2.deliveries
 (consumer,state,next_attempt_at);
CREATE OR REPLACE FUNCTION tala_integration_v2.no_event_change()
RETURNS trigger LANGUAGE plpgsql AS $locked$
BEGIN
 RAISE EXCEPTION 'M11_EVENT_IMMUTABLE' USING ERRCODE='23514';
END $locked$;
CREATE TRIGGER trg_m11_events_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.events
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();
COMMIT;
