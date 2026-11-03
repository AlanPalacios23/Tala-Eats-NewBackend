-- M5 LAB2: every source event is decided once, including suppressed marketing.
-- Channel-specific consent must not force an in-app notification.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_notifications_v2_lab','tala_notifications_v2_test') THEN
   RAISE EXCEPTION 'NOTIFICATIONS_LAB_ONLY';
 END IF;
 IF to_regclass('tala_notifications_v2.inbox') IS NULL THEN
   RAISE EXCEPTION 'NOTIFICATIONS_001_REQUIRED';
 END IF;
END $guard$;

ALTER TABLE tala_notifications_v2.inbox
 ADD COLUMN visible_in_app boolean NOT NULL DEFAULT true;

CREATE TABLE tala_notifications_v2.publication_receipts (
 recipient_id uuid NOT NULL,
 source_event_id uuid NOT NULL,
 app text NOT NULL CHECK(app IN ('customer','restaurant','courier','admin')),
 content_fingerprint text NOT NULL CHECK(content_fingerprint ~ '^[a-f0-9]{64}$'),
 notification_id uuid UNIQUE REFERENCES tala_notifications_v2.inbox(id),
 suppressed boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(recipient_id,source_event_id),
 CONSTRAINT ck_m5_receipt CHECK(
   (suppressed AND notification_id IS NULL)
   OR (NOT suppressed AND notification_id IS NOT NULL))
);
-- Compatibility when migrating an existing disposable LAB1 database.
INSERT INTO tala_notifications_v2.publication_receipts
 (recipient_id,source_event_id,app,content_fingerprint,notification_id,suppressed)
 SELECT recipient_id,source_event_id,app,content_fingerprint,id,false
 FROM tala_notifications_v2.inbox;
CREATE INDEX ix_m5_receipts_created_at
 ON tala_notifications_v2.publication_receipts(created_at);
CREATE INDEX ix_m5_inbox_visible ON tala_notifications_v2.inbox
 (recipient_id,app,created_at DESC,id DESC)
 WHERE visible_in_app AND dismissed_at IS NULL;

COMMIT;
