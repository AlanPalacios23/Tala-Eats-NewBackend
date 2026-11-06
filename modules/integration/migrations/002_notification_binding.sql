-- M11 LAB3: immutable recipient binding for delivery to actual M5 inbox.
-- No customer identity assertion is stored in the event envelope and no PII.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_integration_v2_test','tala_integration_v2_lab') THEN
  RAISE EXCEPTION 'M11_LAB_ONLY';
 END IF;
 IF to_regclass('tala_integration_v2.events') IS NULL
  OR to_regclass('tala_integration_v2.deliveries') IS NULL THEN
  RAISE EXCEPTION 'M11_MIGRATION_001_REQUIRED';
 END IF;
END $guard$;

CREATE TABLE tala_integration_v2.notification_bindings (
 event_id uuid PRIMARY KEY REFERENCES tala_integration_v2.events(event_id),
 recipient_id uuid NOT NULL,
 app text NOT NULL CHECK (app='customer'),
 event_type text NOT NULL CHECK (event_type IN
  ('order.ready','order.delivered')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(app='customer')
);
CREATE INDEX ix_m11_notification_binding_recipient
 ON tala_integration_v2.notification_bindings(recipient_id);

CREATE TRIGGER trg_m11_notification_binding_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.notification_bindings
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();
COMMIT;
