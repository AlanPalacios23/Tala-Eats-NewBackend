-- TALA EATS CORE v2 M5 Notifications LAB0. Independent DB/schema.
-- No accounts, order, delivery, finance or payment dependencies.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_notifications_v2_lab','tala_notifications_v2_test') THEN
   RAISE EXCEPTION 'NOTIFICATIONS_LAB_ONLY';
 END IF;
END $guard$;
CREATE SCHEMA tala_notifications_v2;

CREATE TABLE tala_notifications_v2.preferences (
 recipient_id uuid NOT NULL,
 app text NOT NULL CHECK(app IN ('customer','restaurant','courier','admin')),
 channel text NOT NULL CHECK(channel IN ('in_app','push','email')),
 category text NOT NULL CHECK(category IN ('transactional','marketing')),
 enabled boolean NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(recipient_id,app,channel,category)
);

-- Token is encrypted by the caller's application secret; no plaintext in DB.
CREATE TABLE tala_notifications_v2.devices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 recipient_id uuid NOT NULL,
 app text NOT NULL CHECK(app IN ('customer','restaurant','courier','admin')),
 platform text NOT NULL CHECK(platform IN ('android','ios','web')),
 token_digest text NOT NULL UNIQUE CHECK(token_digest ~ '^[a-f0-9]{64}$'),
 token_iv text NOT NULL CHECK(token_iv ~ '^[a-f0-9]{24}$'),
 token_cipher text NOT NULL CHECK(token_cipher ~ '^[a-f0-9]+$'),
 token_tag text NOT NULL CHECK(token_tag ~ '^[a-f0-9]{32}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz
);
CREATE INDEX ix_m5_devices_recipient ON tala_notifications_v2.devices(recipient_id,app)
 WHERE revoked_at IS NULL;

CREATE TABLE tala_notifications_v2.inbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_event_id uuid NOT NULL,
 recipient_id uuid NOT NULL,
 app text NOT NULL CHECK(app IN ('customer','restaurant','courier','admin')),
 category text NOT NULL CHECK(category IN ('transactional','security','marketing')),
 event_type text NOT NULL CHECK(length(event_type) BETWEEN 4 AND 80),
 content_fingerprint text NOT NULL CHECK(content_fingerprint ~ '^[a-f0-9]{64}$'),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 500),
 deep_link text NOT NULL CHECK(length(deep_link) BETWEEN 1 AND 256),
 data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(data)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 read_at timestamptz,
 dismissed_at timestamptz,
 UNIQUE(recipient_id,source_event_id)
);
CREATE INDEX ix_m5_inbox_recipient ON tala_notifications_v2.inbox
 (recipient_id,app,created_at DESC,id DESC);

CREATE TABLE tala_notifications_v2.deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 notification_id uuid NOT NULL REFERENCES tala_notifications_v2.inbox(id),
 channel text NOT NULL CHECK(channel IN ('email','push')),
 device_id uuid REFERENCES tala_notifications_v2.devices(id),
 status text NOT NULL DEFAULT 'queued'
   CHECK(status IN ('queued','leased','retry','delivered','suppressed','dead_letter')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 12),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_token uuid,
 lease_until timestamptz,
 last_error_code text CHECK(last_error_code IS NULL OR
   (length(last_error_code) BETWEEN 2 AND 60 AND last_error_code ~ '^[A-Z0-9_]+$')),
 delivered_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT ck_m5_destination CHECK(
   (channel='push' AND device_id IS NOT NULL) OR
   (channel='email' AND device_id IS NULL)),
 CONSTRAINT ck_m5_lease CHECK(
   (status='leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
   OR (status<>'leased' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE UNIQUE INDEX uq_m5_email_per_notification ON tala_notifications_v2.deliveries(notification_id)
 WHERE channel='email';
CREATE UNIQUE INDEX uq_m5_push_per_device ON tala_notifications_v2.deliveries(notification_id,device_id)
 WHERE channel='push';
CREATE INDEX ix_m5_claim_due ON tala_notifications_v2.deliveries
 (next_attempt_at,updated_at) WHERE status IN ('queued','retry','leased');

CREATE TABLE tala_notifications_v2.delivery_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 delivery_id uuid NOT NULL REFERENCES tala_notifications_v2.deliveries(id),
 attempt_number integer NOT NULL CHECK(attempt_number BETWEEN 1 AND 12),
 result text NOT NULL CHECK(result IN ('delivered','retry','dead_letter','suppressed')),
 error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Z0-9_]{2,60}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(delivery_id,attempt_number)
);
CREATE FUNCTION tala_notifications_v2.block_attempt_tampering()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
 RAISE EXCEPTION 'NOTIFICATIONS_ATTEMPTS_IMMUTABLE' USING ERRCODE='23514';
END $fn$;
CREATE TRIGGER trg_m5_attempts_immutable BEFORE UPDATE OR DELETE
ON tala_notifications_v2.delivery_attempts
FOR EACH ROW EXECUTE FUNCTION tala_notifications_v2.block_attempt_tampering();
COMMIT;
