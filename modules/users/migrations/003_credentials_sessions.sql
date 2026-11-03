-- M4 Usuarios LAB2: credentials and revocable identity sessions ONLY.
-- Apply 001 + 002 first. No HTTP, payment, order, finance, mailer or live DB.
-- Password verifiers use scrypt with an application-owned pepper. Never store
-- plaintext passwords, session bearer tokens, or email challenge tokens.
BEGIN;
DO $guard$
BEGIN
  IF current_database() NOT IN ('tala_users_v2_lab','tala_users_v2_test') THEN
    RAISE EXCEPTION 'USERS_LAB_ONLY';
  END IF;
  IF to_regclass('tala_users_v2.accounts') IS NULL OR
     to_regclass('tala_users_v2.email_challenges') IS NULL THEN
    RAISE EXCEPTION 'USERS_001_002_REQUIRED';
  END IF;
END $guard$;

CREATE TABLE tala_users_v2.password_credentials (
  account_id uuid PRIMARY KEY REFERENCES tala_users_v2.accounts(id),
  salt_hex text NOT NULL CHECK (salt_hex ~ '^[a-f0-9]{32}$'),
  verifier_hex text NOT NULL CHECK (verifier_hex ~ '^[a-f0-9]{64}$'),
  failed_attempts integer NOT NULL DEFAULT 0
    CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE tala_users_v2.sessions (
  token_digest text PRIMARY KEY CHECK(token_digest ~ '^[a-f0-9]{64}$'),
  account_id uuid NOT NULL REFERENCES tala_users_v2.accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT ck_m4_session_window CHECK(
    expires_at>created_at AND expires_at<=created_at+interval '12 hours'
    AND (revoked_at IS NULL OR revoked_at>=created_at)
  )
);
CREATE INDEX ix_m4_sessions_account ON
  tala_users_v2.sessions(account_id,expires_at DESC)
  WHERE revoked_at IS NULL;

-- SQL must not grant active sessions for unverified/suspended/tombstoned accounts.
CREATE FUNCTION tala_users_v2.verify_session_eligible()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  allowed boolean;
BEGIN
  SELECT (status='active' AND email_verified_at IS NOT NULL)
  INTO allowed FROM tala_users_v2.accounts
  WHERE id=NEW.account_id FOR UPDATE;
  IF allowed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'USERS_SESSION_ACCOUNT_NOT_ELIGIBLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_m4_session_eligibility
  BEFORE INSERT ON tala_users_v2.sessions
  FOR EACH ROW EXECUTE FUNCTION tala_users_v2.verify_session_eligible();

-- A suspended or deleting account immediately loses all bearer sessions.
-- On finalized deletion remove password verifiers, session digests and
-- residual email challenges but keep the anonymous account/audit tombstone.
CREATE FUNCTION tala_users_v2.revoke_on_account_restriction()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status IN ('suspended','deletion_requested','deleted') THEN
      UPDATE tala_users_v2.sessions
      SET revoked_at=clock_timestamp()
      WHERE account_id=NEW.id AND revoked_at IS NULL;
    END IF;
    IF NEW.status='deleted' THEN
      DELETE FROM tala_users_v2.sessions WHERE account_id=NEW.id;
      DELETE FROM tala_users_v2.password_credentials WHERE account_id=NEW.id;
      DELETE FROM tala_users_v2.email_challenges WHERE account_id=NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_m4_account_session_revocation
  AFTER UPDATE OF status ON tala_users_v2.accounts
  FOR EACH ROW EXECUTE FUNCTION tala_users_v2.revoke_on_account_restriction();
COMMIT;
