-- M9 Security LAB2: atomic revocation and local abuse signals, no production DB.
BEGIN;
DO $lab$
BEGIN
 IF current_database() NOT IN ('tala_security_v2_test','tala_security_v2_lab') THEN
   RAISE EXCEPTION 'SECURITY_LAB_ONLY';
 END IF;
 IF to_regclass('tala_security_v2.used_grants') IS NULL THEN
   RAISE EXCEPTION 'M9_MIGRATION_001_REQUIRED';
 END IF;
END $lab$;

-- Subject-wide invalidation takes effect for grants issued in or before the
-- revocation second. Host should issue fresh grants only after that second.
CREATE TABLE tala_security_v2.subject_revocations(
 subject_hash text PRIMARY KEY CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 revoked_before bigint NOT NULL CHECK(revoked_before >= 0),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE tala_security_v2.grant_revocations(
 grant_id uuid PRIMARY KEY,
 subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_m9_grant_revocations_expiry
 ON tala_security_v2.grant_revocations(expires_at);

ALTER TABLE tala_security_v2.audit_events
 DROP CONSTRAINT audit_events_decision_check;
ALTER TABLE tala_security_v2.audit_events ADD CONSTRAINT audit_events_decision_check
 CHECK(decision IN ('allow','deny_scope','deny_assurance','deny_replay',
   'deny_rate','deny_revoked'));

-- Local observable detection: no emails, IPs, raw session tokens, secrets or
-- notification dispatch. One alert per actor/action/type/five-minute window.
CREATE TABLE tala_security_v2.abuse_alerts(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
 action text NOT NULL CHECK(length(action) BETWEEN 3 AND 64),
 kind text NOT NULL CHECK(kind IN
  ('replay_burst','scope_probing','rate_pressure')),
 window_start bigint NOT NULL CHECK(window_start>=0),
 observed_denials integer NOT NULL CHECK(observed_denials>=3),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(subject_hash,action,kind,window_start)
);
CREATE INDEX ix_m9_alert_time ON tala_security_v2.abuse_alerts(created_at DESC);
CREATE TRIGGER trg_m9_abuse_alerts_immutable BEFORE UPDATE OR DELETE
 ON tala_security_v2.abuse_alerts FOR EACH ROW
 EXECUTE FUNCTION tala_security_v2.reject_audit_mutation();
COMMIT;
