-- M5 LAB4: priority is computed from allowlisted event types, never client input.
BEGIN;
DO $gate$
BEGIN
  IF current_database() NOT IN ('tala_notifications_v2_lab','tala_notifications_v2_test') THEN
    RAISE EXCEPTION 'NOTIFICATIONS_LAB_ONLY';
  END IF;
  IF to_regclass('tala_notifications_v2.deliveries') IS NULL OR
     to_regclass('tala_notifications_v2.publication_receipts') IS NULL THEN
    RAISE EXCEPTION 'NOTIFICATIONS_001_002_REQUIRED';
  END IF;
END $gate$;
ALTER TABLE tala_notifications_v2.deliveries
  ADD COLUMN priority smallint NOT NULL DEFAULT 60
  CONSTRAINT ck_m5_priority CHECK(priority BETWEEN 0 AND 100);
-- Preserve high-priority safety/dispatch messages under bursty marketing load.
CREATE INDEX ix_m5_due_priority
 ON tala_notifications_v2.deliveries(priority DESC,next_attempt_at,id)
 WHERE status IN ('queued','retry');
CREATE INDEX ix_m5_expired_leases
 ON tala_notifications_v2.deliveries(lease_until,id)
 WHERE status='leased';
-- Existing records are low-volume LAB; derive priority when migrating.
UPDATE tala_notifications_v2.deliveries d
SET priority=CASE
 WHEN i.category='security' THEN 100
 WHEN i.event_type IN ('courier.offer','courier.assigned') THEN 95
 WHEN i.event_type IN ('restaurant.new_order','courier.pickup_ready') THEN 90
 WHEN i.event_type IN ('order.ready','order.picked_up','order.delivered',
                       'order.cancelled','order.refund_status') THEN 80
 WHEN i.category='marketing' THEN 10
 ELSE 60 END
FROM tala_notifications_v2.inbox i
WHERE i.id=d.notification_id;
COMMIT;
