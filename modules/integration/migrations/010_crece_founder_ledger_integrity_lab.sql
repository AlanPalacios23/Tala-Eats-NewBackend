-- M11 Crece LAB: founder ledger integrity, immutable interest and quota reconciliation.
-- This migration must never run in customer/merchant/driver LIVE databases.
BEGIN;
DO $gate$
BEGIN
 IF current_database() NOT IN ('tala_integration_v2_test','tala_integration_v2_lab') THEN
  RAISE EXCEPTION 'M11_CRECE_LAB_ONLY';
 END IF;
 IF to_regclass('tala_integration_v2.crece_founder_reviews') IS NULL OR
    to_regclass('tala_integration_v2.crece_founder_quota') IS NULL OR
    to_regclass('tala_integration_v2.crece_founder_consents') IS NULL THEN
  RAISE EXCEPTION 'M11_CRECE_009_REQUIRED';
 END IF;
END $gate$;

-- Even if an internal adapter has a bug, accepted terms, the interested
-- store, and application owner may never be silently rewritten or deleted.
CREATE TRIGGER trg_crece_interest_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.crece_founder_interest
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();

-- A single UPDATE on the quota table must never manufacture or free seats:
-- the final number of approved reviews is the only source of truth.
-- DEFERRABLE is required because review insertion increments quota first.
CREATE FUNCTION tala_integration_v2.assert_crece_founder_quota()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE recorded integer; actual integer;
BEGIN
 SELECT approved_count INTO recorded
  FROM tala_integration_v2.crece_founder_quota
  WHERE program_id='crece-founder-pilot-2026-11-v1';
 SELECT count(*)::integer INTO actual
  FROM tala_integration_v2.crece_founder_reviews
  WHERE decision='approved';
 IF recorded IS NULL OR recorded<>actual THEN
  RAISE EXCEPTION 'CRECE_FOUNDER_QUOTA_LEDGER_MISMATCH'
   USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $function$;
CREATE CONSTRAINT TRIGGER trg_crece_quota_reconcile
 AFTER INSERT OR UPDATE OR DELETE
 ON tala_integration_v2.crece_founder_quota
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION tala_integration_v2.assert_crece_founder_quota();
CREATE CONSTRAINT TRIGGER trg_crece_reviews_reconcile
 AFTER INSERT OR UPDATE OR DELETE
 ON tala_integration_v2.crece_founder_reviews
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION tala_integration_v2.assert_crece_founder_quota();

-- At migration time, fail if existing LAB history is already inconsistent.
DO $check$
DECLARE recorded integer; actual integer;
BEGIN
 SELECT approved_count INTO recorded
  FROM tala_integration_v2.crece_founder_quota
  WHERE program_id='crece-founder-pilot-2026-11-v1';
 SELECT count(*)::integer INTO actual
  FROM tala_integration_v2.crece_founder_reviews
  WHERE decision='approved';
 IF recorded IS NULL OR recorded<>actual THEN
  RAISE EXCEPTION 'CRECE_FOUNDER_QUOTA_LEDGER_MISMATCH';
 END IF;
END $check$;
COMMIT;
