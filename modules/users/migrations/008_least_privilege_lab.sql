-- LAB7 least-privilege demonstration. Role is NOLOGIN, not a real
-- production credential. Do not use owner/superuser for a deployed API.
BEGIN;
DO $guard$
BEGIN
  IF current_database() NOT IN ('tala_users_v2_lab','tala_users_v2_test') THEN
    RAISE EXCEPTION 'USERS_LAB_ONLY';
  END IF;
  IF to_regclass('tala_users_v2.account_roles') IS NULL OR
     to_regclass('tala_users_v2.user_totp') IS NULL THEN
    RAISE EXCEPTION 'USERS_006_007_REQUIRED';
  END IF;
END $guard$;

-- Trigger functions execute as schema owner so the application DB role
-- cannot grant itself staff/owner by creating or updating account_roles.
ALTER FUNCTION tala_users_v2.create_customer_role()
  SECURITY DEFINER SET search_path=pg_catalog,tala_users_v2;
ALTER FUNCTION tala_users_v2.purge_private_profile_on_deletion()
  SECURITY DEFINER SET search_path=pg_catalog,tala_users_v2;

CREATE ROLE tala_users_v2_runtime NOLOGIN;
GRANT USAGE ON SCHEMA tala_users_v2 TO tala_users_v2_runtime;
GRANT SELECT ON tala_users_v2.account_roles TO tala_users_v2_runtime;
GRANT SELECT,INSERT,UPDATE ON tala_users_v2.accounts TO tala_users_v2_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON
  tala_users_v2.email_challenges,
  tala_users_v2.password_credentials,
  tala_users_v2.sessions,
  tala_users_v2.password_recovery,
  tala_users_v2.user_totp,
  tala_users_v2.saved_addresses,
  tala_users_v2.user_preferences
  TO tala_users_v2_runtime;
GRANT SELECT,INSERT ON tala_users_v2.account_audit TO tala_users_v2_runtime;
GRANT USAGE,SELECT ON SEQUENCE tala_users_v2.account_audit_id_seq
  TO tala_users_v2_runtime;
REVOKE ALL ON tala_users_v2.account_roles FROM PUBLIC;
REVOKE ALL ON tala_users_v2.account_roles FROM tala_users_v2_runtime;
GRANT SELECT ON tala_users_v2.account_roles TO tala_users_v2_runtime;
COMMIT;
