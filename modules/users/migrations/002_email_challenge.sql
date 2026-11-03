-- M4 Usuarios LAB1: email verification proof, no sender/HTTP/authentication.
-- Apply AFTER 001 on the isolated user database. All issued credentials
-- are HMAC digests; the raw secret/token must never be persisted in SQL.
BEGIN;
DO $check$
BEGIN
  IF current_database() NOT IN ('tala_users_v2_lab','tala_users_v2_test') THEN
    RAISE EXCEPTION 'USERS_LAB_ONLY';
  END IF;
  IF to_regclass('tala_users_v2.accounts') IS NULL THEN
    RAISE EXCEPTION 'USERS_001_REQUIRED';
  END IF;
END $check$;

CREATE TABLE tala_users_v2.email_challenges (
  account_id uuid PRIMARY KEY REFERENCES tala_users_v2.accounts(id),
  token_digest text NOT NULL CHECK(token_digest ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 5),
  consumed_at timestamptz,
  CONSTRAINT ck_m4_email_challenge_window CHECK (
    expires_at>issued_at AND
    expires_at<=issued_at+interval '15 minutes' AND
    (consumed_at IS NULL OR
      (consumed_at>=issued_at AND consumed_at<=expires_at))
  )
);
CREATE INDEX ix_m4_challenge_expiration
  ON tala_users_v2.email_challenges(expires_at);

-- The original 001 trigger alone was not enough: a writer could fabricate
-- email_verified_at. This additional guard forbids email activation unless
-- a consumed, unexpired, non-exhausted challenge is present.
CREATE FUNCTION tala_users_v2.require_consumed_challenge()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.status='pending_verification' AND NEW.status='active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM tala_users_v2.email_challenges c
      WHERE c.account_id=NEW.id
        AND c.consumed_at IS NOT NULL
        AND c.consumed_at=NEW.email_verified_at
        AND c.consumed_at<=c.expires_at
        AND c.failed_attempts<5
    ) THEN
      RAISE EXCEPTION 'USERS_VERIFICATION_PROOF_REQUIRED' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_m4_verified_proof
  BEFORE UPDATE ON tala_users_v2.accounts
  FOR EACH ROW EXECUTE FUNCTION tala_users_v2.require_consumed_challenge();

COMMIT;
