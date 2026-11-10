-- LAB only: isolated drafts for the EIGHT future Crece capabilities.
-- No coupons active, orders reserved, money credited or badges issued.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_integration_v2_test','tala_integration_v2_lab') THEN
  RAISE EXCEPTION 'M11_CRECE_LAB_ONLY';
 END IF;
 IF to_regclass('tala_integration_v2.crece_assisted_requests') IS NULL THEN
  RAISE EXCEPTION 'M11_CRECE_012_REQUIRED';
 END IF;
END $guard$;
CREATE TABLE tala_integration_v2.crece_feature_drafts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_id uuid NOT NULL,
 owner_id uuid NOT NULL,
 feature_id text NOT NULL CHECK(feature_id IN
 ('cupones','temporadas','programados','combos','sucursales',
  'fidelidad','empresas','calidad')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(store_id,feature_id)
);
CREATE TABLE tala_integration_v2.crece_feature_draft_versions(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 draft_id uuid NOT NULL REFERENCES tala_integration_v2.crece_feature_drafts(id),
 operation_id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 100),
 proposal jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(draft_id,revision),
 CHECK(jsonb_typeof(proposal)='object'),
 CHECK(octet_length(proposal::text)<=5000)
);
CREATE INDEX crece_feature_draft_versions_latest ON
 tala_integration_v2.crece_feature_draft_versions(draft_id,revision DESC);
CREATE TRIGGER trg_crece_feature_drafts_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.crece_feature_drafts
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();
CREATE TRIGGER trg_crece_feature_draft_versions_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.crece_feature_draft_versions
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();
COMMIT;
