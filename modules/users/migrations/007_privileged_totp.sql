-- M4 LAB6: encrypted TOTP factors and privileged-session fail-closed gate.
-- Role elevations are out of band; public registration always customer.
BEGIN;
DO $gate$
BEGIN
  IF current_database() NOT IN ('tala_users_v2_lab','tala_users_v2_test') THEN
    RAISE EXCEPTION 'USERS_LAB_ONLY';
  END IF;
  IF to_regclass('tala_users_v2.account_roles') IS NULL OR
    to_regclass('tala_users_v2.sessions') IS NULL THEN
    RAISE EXCEPTION 'USERS_006_REQUIRED';
  END IF;
END $gate$;

CREATE TABLE tala_users_v2.user_totp (
  account_id uuid PRIMARY KEY REFERENCES tala_users_v2.accounts(id),
  secret_iv_hex text NOT NULL CHECK(secret_iv_hex ~ '^[a-f0-9]{24}$'),
  secret_cipher_hex text NOT NULL CHECK(secret_cipher_hex ~ '^[a-f0-9]{40}$'),
  secret_tag_hex text NOT NULL CHECK(secret_tag_hex ~ '^[a-f0-9]{32}$'),
  enabled_at timestamptz,
  last_counter bigint NOT NULL DEFAULT -1,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE tala_users_v2.sessions
  ADD COLUMN mfa_verified boolean NOT NULL DEFAULT false;

CREATE FUNCTION tala_users_v2.require_mfa_for_privileged_roles()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'USERS_ROLE_ID_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF OLD.role IS DISTINCT FROM NEW.role THEN
    IF NEW.role IN ('owner','staff') AND
      NOT EXISTS (
        SELECT 1 FROM tala_users_v2.user_totp
        WHERE account_id=NEW.account_id AND enabled_at IS NOT NULL
      ) THEN
      RAISE EXCEPTION 'USERS_PRIVILEGED_MFA_REQUIRED' USING ERRCODE='23514';
    END IF;
    -- Any change of role invalidates bearer tokens issued for previous role.
    UPDATE tala_users_v2.sessions SET revoked_at=clock_timestamp()
    WHERE account_id=NEW.account_id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_m4_role_elevation
  BEFORE UPDATE ON tala_users_v2.account_roles
  FOR EACH ROW EXECUTE FUNCTION tala_users_v2.require_mfa_for_privileged_roles();

CREATE OR REPLACE FUNCTION tala_users_v2.verify_session_eligible()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  allowed boolean;
  assigned text;
BEGIN
  SELECT a.status='active' AND a.email_verified_at IS NOT NULL,r.role
    INTO allowed,assigned
  FROM tala_users_v2.accounts a
  JOIN tala_users_v2.account_roles r ON r.account_id=a.id
  WHERE a.id=NEW.account_id FOR UPDATE OF a;
  IF allowed IS DISTINCT FROM true OR
     (assigned IN ('staff','owner') AND NOT NEW.mfa_verified) THEN
    RAISE EXCEPTION 'USERS_SESSION_ACCOUNT_NOT_ELIGIBLE'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;

CREATE FUNCTION tala_users_v2.purge_totp_on_account_deletion()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status='deleted' AND OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM tala_users_v2.user_totp WHERE account_id=NEW.id;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_m4_purge_totp
  AFTER UPDATE OF status ON tala_users_v2.accounts
  FOR EACH ROW EXECUTE FUNCTION tala_users_v2.purge_totp_on_account_deletion();
COMMIT;
