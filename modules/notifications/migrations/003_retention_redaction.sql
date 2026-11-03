-- M5 LAB3: token secret scrubbing and event-body retention, preserving
-- immutable delivery attempt audit and publication idempotency.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_notifications_v2_lab','tala_notifications_v2_test') THEN
   RAISE EXCEPTION 'NOTIFICATIONS_LAB_ONLY';
 END IF;
 IF to_regclass('tala_notifications_v2.devices') IS NULL OR
    to_regclass('tala_notifications_v2.publication_receipts') IS NULL THEN
   RAISE EXCEPTION 'NOTIFICATIONS_001_002_REQUIRED';
 END IF;
END $guard$;
ALTER TABLE tala_notifications_v2.devices
 ADD COLUMN token_redacted_at timestamptz,
 ADD CONSTRAINT ck_m5_token_redacted_only_revoked
   CHECK(token_redacted_at IS NULL OR revoked_at IS NOT NULL);

ALTER TABLE tala_notifications_v2.inbox
 ADD COLUMN content_redacted_at timestamptz,
 ADD CONSTRAINT ck_m5_content_redacted_hidden
   CHECK(content_redacted_at IS NULL OR NOT visible_in_app);

CREATE INDEX ix_m5_devices_pending_scrub
 ON tala_notifications_v2.devices(revoked_at,id)
 WHERE revoked_at IS NOT NULL AND token_redacted_at IS NULL;
CREATE INDEX ix_m5_inbox_pending_redaction
 ON tala_notifications_v2.inbox(created_at,id)
 WHERE content_redacted_at IS NULL;
COMMIT;
