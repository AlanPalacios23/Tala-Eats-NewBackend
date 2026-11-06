-- M4 LAB4: public, random session identifier separate from bearer digest.
BEGIN;
DO $guard$
BEGIN
  IF current_database() NOT IN ('tala_users_v2_lab','tala_users_v2_test') THEN
    RAISE EXCEPTION 'USERS_LAB_ONLY';
  END IF;
  IF to_regclass('tala_users_v2.sessions') IS NULL THEN
    RAISE EXCEPTION 'USERS_003_REQUIRED';
  END IF;
END $guard$;
ALTER TABLE tala_users_v2.sessions
  ADD COLUMN session_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX ix_m4_session_public_id
  ON tala_users_v2.sessions(session_id);
COMMIT;
