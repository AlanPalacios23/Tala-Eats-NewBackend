-- M11 LAB5 — immutable branch/variant mapping to legacy M1 catalog.
-- No cross-database FKs. Never touches M6 or M1 data/permissions.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN
    ('tala_integration_v2_test','tala_integration_v2_lab') THEN
  RAISE EXCEPTION 'M11_LAB_ONLY';
 END IF;
 IF to_regclass('tala_integration_v2.events') IS NULL THEN
  RAISE EXCEPTION 'M11_MIGRATION_001_REQUIRED';
 END IF;
END $guard$;

CREATE TABLE tala_integration_v2.branch_catalog_links (
 m6_store_id uuid NOT NULL,
 m6_branch_id uuid PRIMARY KEY,
 m1_restaurant_id uuid NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(m6_store_id,m6_branch_id,m1_restaurant_id)
);

CREATE TABLE tala_integration_v2.variant_catalog_links (
 m6_store_id uuid NOT NULL,
 m6_branch_id uuid NOT NULL,
 m6_variant_id uuid NOT NULL,
 m1_restaurant_id uuid NOT NULL,
 m1_product_id uuid NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(m6_branch_id,m6_variant_id),
 FOREIGN KEY(m6_store_id,m6_branch_id,m1_restaurant_id)
  REFERENCES tala_integration_v2.branch_catalog_links
  (m6_store_id,m6_branch_id,m1_restaurant_id)
);
CREATE INDEX ix_m11_catalog_variant
 ON tala_integration_v2.variant_catalog_links(m6_variant_id);

-- Modification of bound identities/variants requires an explicit new
-- incident/migration procedure, never an UPDATE from frontend.
CREATE TRIGGER trg_m11_branch_catalog_link_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.branch_catalog_links
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();
CREATE TRIGGER trg_m11_variant_catalog_link_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.variant_catalog_links
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();
COMMIT;
