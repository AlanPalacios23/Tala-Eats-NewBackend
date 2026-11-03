-- M4 LAB8: bounded PostgreSQL-based, cross-process request throttling.
BEGIN;
DO $gate$
BEGIN
  IF current_database() NOT IN ('tala_users_v2_lab','tala_users_v2_test') THEN
    RAISE EXCEPTION 'USERS_LAB_ONLY';
  END IF;
  IF to_regclass('tala_users_v2.sessions') IS NULL THEN
    RAISE EXCEPTION 'USERS_003_REQUIRED';
  END IF;
END $gate$;
CREATE TABLE tala_users_v2.request_rate_buckets (
  subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL,
  requests integer NOT NULL DEFAULT 1 CHECK(requests BETWEEN 1 AND 2147483647),
  PRIMARY KEY(subject_hash,window_started_at)
);
CREATE INDEX ix_m4_rate_bucket_expiration ON
  tala_users_v2.request_rate_buckets(window_started_at);
GRANT SELECT,INSERT,UPDATE,DELETE ON tala_users_v2.request_rate_buckets
  TO tala_users_v2_runtime;
COMMIT;
