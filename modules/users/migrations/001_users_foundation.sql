-- TALA EATS CORE v2 — M4 USUARIOS only, isolated PostgreSQL laboratory.
-- No M1/M2/M3 tables, no credentials, sessions, notifications or money.
BEGIN;
DO $check$
BEGIN
  IF current_database() NOT IN ('tala_users_v2_lab','tala_users_v2_test') THEN
    RAISE EXCEPTION 'USERS_LAB_ONLY';
  END IF;
END $check$;
CREATE SCHEMA tala_users_v2;

CREATE TABLE tala_users_v2.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification' CHECK
    (status IN ('pending_verification','active','suspended',
                'deletion_requested','deleted')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  email_verified_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_m4_email CHECK (
    email_normalized=lower(email_normalized) AND
    length(email_normalized) BETWEEN 6 AND 254 AND
    email_normalized ~ '^[a-z0-9_%+.-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' AND
    email_normalized !~ '\.\.' AND
    (split_part(email_normalized,'@',1)) !~ '(^\.|\.$)'
  ),
  CONSTRAINT ck_m4_display_name CHECK (
    length(display_name) BETWEEN 2 AND 80 AND
    octet_length(display_name)<=180 AND
    display_name=btrim(display_name) AND
    display_name !~ '[[:cntrl:]<>]'
  ),
  CONSTRAINT ck_m4_deleted CHECK (
    (status='deleted' AND deleted_at IS NOT NULL) OR
    (status<>'deleted' AND deleted_at IS NULL)
  )
);

CREATE TABLE tala_users_v2.account_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES tala_users_v2.accounts(id),
  event_key text NOT NULL UNIQUE CHECK(event_key ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN (
    'register_pending','email_verified','suspend','reinstate',
    'request_deletion','finalize_deletion','profile_updated'
  )),
  from_status text,
  to_status text NOT NULL,
  actor_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_m4_event_status CHECK (
    to_status IN ('pending_verification','active','suspended',
                  'deletion_requested','deleted') AND
    (from_status IS NULL OR from_status IN (
      'pending_verification','active','suspended',
      'deletion_requested','deleted'))
  )
);
CREATE INDEX ix_m4_account_audit_user
  ON tala_users_v2.account_audit(account_id,id);

CREATE FUNCTION tala_users_v2.prevent_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'USERS_AUDIT_IMMUTABLE';
END $fn$;
CREATE TRIGGER trg_m4_account_audit_immutable
  BEFORE UPDATE OR DELETE ON tala_users_v2.account_audit
  FOR EACH ROW EXECUTE FUNCTION tala_users_v2.prevent_audit_mutation();

CREATE FUNCTION tala_users_v2.enforce_account_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.id<>OLD.id OR NEW.created_at<>OLD.created_at OR
     NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at OR
     OLD.status='deleted' THEN
    RAISE EXCEPTION 'USERS_ACCOUNT_MUTATION_DENIED' USING ERRCODE='23514';
  END IF;
  IF NEW.status<>OLD.status THEN
    IF NOT (
      (OLD.status='pending_verification' AND
       NEW.status IN ('active','deletion_requested')) OR
      (OLD.status='active' AND
       NEW.status IN ('suspended','deletion_requested')) OR
      (OLD.status='suspended' AND
       NEW.status IN ('active','deletion_requested')) OR
      (OLD.status='deletion_requested' AND NEW.status='deleted')
    ) THEN
      RAISE EXCEPTION 'USERS_STATE_TRANSITION_DENIED' USING ERRCODE='23514';
    END IF;
    IF NEW.status<>'deleted' AND NEW.display_name<>OLD.display_name THEN
      RAISE EXCEPTION 'USERS_PROFILE_TRANSITION_CONFLICT' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.status<>'active' THEN
    RAISE EXCEPTION 'USERS_PROFILE_STATE_DENIED' USING ERRCODE='23514';
  END IF;
  IF NEW.status='deleted' THEN
    IF NEW.email_normalized<>('deleted.'||NEW.id::text||'@users.invalid') OR
       NEW.display_name<>'Cuenta eliminada' OR NEW.deleted_at IS NULL THEN
      RAISE EXCEPTION 'USERS_ERASURE_CONTRACT_INVALID' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.email_normalized<>OLD.email_normalized OR
        NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'USERS_EMAIL_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF NEW.status='active' AND NEW.email_verified_at IS NULL THEN
    RAISE EXCEPTION 'USERS_ACTIVE_NEEDS_VERIFICATION' USING ERRCODE='23514';
  END IF;
  IF NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at AND
     NOT (OLD.status='pending_verification' AND NEW.status='active'
      AND OLD.email_verified_at IS NULL AND NEW.email_verified_at IS NOT NULL)
  THEN
    RAISE EXCEPTION 'USERS_VERIFICATION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_m4_account_lifecycle
  BEFORE UPDATE ON tala_users_v2.accounts
  FOR EACH ROW EXECUTE FUNCTION tala_users_v2.enforce_account_lifecycle();

COMMIT;
