-- Tala Eats Core v2 — M9 Security LAB1. Independent defensive gateway.
BEGIN;
DO $lab$
BEGIN
 IF current_database() NOT IN ('tala_security_v2_test','tala_security_v2_lab') THEN
   RAISE EXCEPTION 'SECURITY_LAB_ONLY';
 END IF;
END $lab$;
CREATE SCHEMA tala_security_v2;
CREATE TABLE tala_security_v2.used_grants(
 grant_id uuid PRIMARY KEY,
 subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 action text NOT NULL CHECK(length(action) BETWEEN 3 AND 64),
 consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL
);
CREATE INDEX ix_m9_used_grants_expiry ON tala_security_v2.used_grants(expires_at);
CREATE TABLE tala_security_v2.rate_buckets(
 subject_action_hash text NOT NULL CHECK(subject_action_hash ~ '^[a-f0-9]{64}$'),
 window_start bigint NOT NULL CHECK(window_start >= 0),
 hits integer NOT NULL CHECK(hits BETWEEN 1 AND 1000000),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(subject_action_hash,window_start)
);
CREATE INDEX ix_m9_rate_buckets_expiry ON tala_security_v2.rate_buckets(expires_at);
CREATE TABLE tala_security_v2.audit_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 action text NOT NULL CHECK(length(action) BETWEEN 3 AND 64),
 decision text NOT NULL CHECK(decision IN
  ('allow','deny_scope','deny_assurance','deny_replay','deny_rate')),
 at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_m9_audit_time ON tala_security_v2.audit_events(at DESC);
CREATE OR REPLACE FUNCTION tala_security_v2.reject_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $immutable$
BEGIN
 RAISE EXCEPTION 'SECURITY_AUDIT_IMMUTABLE' USING ERRCODE='23514';
END $immutable$;
CREATE TRIGGER trg_m9_audit_immutable BEFORE UPDATE OR DELETE
 ON tala_security_v2.audit_events FOR EACH ROW
 EXECUTE FUNCTION tala_security_v2.reject_audit_mutation();
COMMIT;
