-- M11 LAB7: versioned outbox routing for real M1 pickup READY/COMPLETED.
-- Never infer paid status from order creation; only M1 verified handoff.
BEGIN;
DO $gate$
BEGIN
 IF current_database() NOT IN ('tala_integration_v2_test','tala_integration_v2_lab')
  THEN RAISE EXCEPTION 'M11_LAB_ONLY';
 END IF;
 IF to_regclass('tala_integration_v2.events') IS NULL
  OR to_regclass('tala_integration_v2.notification_bindings') IS NULL
  THEN RAISE EXCEPTION 'M11_MIGRATIONS_001_002_REQUIRED';
 END IF;
END $gate$;

ALTER TABLE tala_integration_v2.events DROP CONSTRAINT IF EXISTS events_kind_check;
ALTER TABLE tala_integration_v2.events DROP CONSTRAINT IF EXISTS events_check;
ALTER TABLE tala_integration_v2.events ADD CONSTRAINT ck_m11_event_kind_v2
 CHECK(kind IN ('orders.order_created','restaurants.order_ready',
 'logistics.delivery_completed','orders.pickup_ready','orders.pickup_completed'));
ALTER TABLE tala_integration_v2.events ADD CONSTRAINT ck_m11_event_source_kind_v2
 CHECK (
  (source='orders' AND kind IN
   ('orders.order_created','orders.pickup_ready','orders.pickup_completed')) OR
  (source='restaurants' AND kind='restaurants.order_ready') OR
  (source='logistics' AND kind='logistics.delivery_completed')
 );
COMMIT;
