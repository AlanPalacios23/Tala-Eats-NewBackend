-- M4 LAB3: password recovery proofs and credential audit, USERS ONLY.
-- Required: migrations 001, 002 and 003. No external email sender here.
BEGIN;
DO $gate$
BEGIN
  IF current_database() NOT IN ('tala_users_v2_lab','tala_users_v2_test') THEN
    RAISE EXCEPTION 'USERS_LAB_ONLY';
  END IF;
  IF to_regclass('tala_users_v2.accounts') IS NULL OR
     to_regclass('tala_users_v2.email_challenges') IS NULL OR
     to_regclass('tala_users_v2.password_credentials') IS NULL OR
     to_regclass('tala_users_v2.sessions') IS NULL THEN
    RAISE EXCEPTION 'USERS_001_002_003_REQUIRED';
  END IF;
END $gate$;

CREATE TABLE tala_users_v2.password_recovery (
  account_id uuid PRIMARY KEY REFERENCES tala_users_v2.accounts(id),
  token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0
    CHECK(failed_attempts BETWEEN 0 AND 5),
  consumed_at timestamptz,
  CONSTRAINT ck_m4_password_recovery_window CHECK(
    expires_at>issued_at AND
    expires_at<=issued_at+interval '15 minutes' AND
    (consumed_at IS NULL OR
      (consumed_at>=issued_at AND consumed_at<=expires_at))
  )
);

-- Audited identity credential changes; no passwords, raw tokens, emails or
-- session secrets in immutable audit rows.
ALTER TABLE tala_users_v2.account_audit
  DROP CONSTRAINT account_audit_action_check;
ALTER TABLE tala_users_v2.account_audit
  ADD CONSTRAINT account_audit_action_check CHECK(action IN(
    'register_pending','email_verified','suspend','reinstate',
    'request_deletion','finalize_deletion','profile_updated',
    'password_changed','password_reset'
  ));

-- Once the account is tombstoned, no recovery secrets can remain.
CREATE OR REPLACE FUNCTION tala_users_v2.revoke_on_account_restriction()
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
      DELETE FROM tala_users_v2.password_recovery WHERE account_id=NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
COMMIT;
