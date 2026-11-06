-- M11 LAB4: explicit pairwise custody proof linking independently owned
-- M4 and M1 customer accounts. NEVER infer ownership from email/UUID alone.
-- Separate LAB databases cannot use foreign keys across module DBs.
BEGIN;
DO $gate$
BEGIN
 IF current_database() NOT IN ('tala_integration_v2_test',
                                'tala_integration_v2_lab') THEN
  RAISE EXCEPTION 'M11_LAB_ONLY';
 END IF;
 IF to_regclass('tala_integration_v2.events') IS NULL THEN
  RAISE EXCEPTION 'M11_MIGRATION_001_REQUIRED';
 END IF;
END $gate$;

CREATE TABLE tala_integration_v2.customer_identity_links (
 m4_user_id uuid PRIMARY KEY,
 m1_customer_id uuid NOT NULL UNIQUE,
 proof_method text NOT NULL DEFAULT 'dual_active_sessions_lab'
   CHECK(proof_method='dual_active_sessions_lab'),
 verified_email_match boolean NOT NULL DEFAULT true
   CHECK(verified_email_match=true),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Revocations are append-only; once revoked, neither user may reuse
-- their old binding without a separately reviewed migration/protocol.
CREATE TABLE tala_integration_v2.customer_link_revocations (
 m4_user_id uuid PRIMARY KEY
   REFERENCES tala_integration_v2.customer_identity_links(m4_user_id),
 reason text NOT NULL CHECK(reason IN
  ('account_compromise','account_deleted','owner_request','admin_review')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER trg_m11_customer_links_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.customer_identity_links
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();

CREATE TRIGGER trg_m11_customer_revocations_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.customer_link_revocations
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();
COMMIT;
