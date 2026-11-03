-- M5 LAB2: channel-specific visibility, never make push/email depend on inbox opt-in.
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
  ADD COLUMN in_app_visible boolean NOT NULL DEFAULT true;
CREATE INDEX ix_m5_visible_inbox ON tala_notifications_v2.inbox
  (recipient_id,app,created_at DESC,id DESC)
  WHERE in_app_visible AND dismissed_at IS NULL;
COMMIT;
