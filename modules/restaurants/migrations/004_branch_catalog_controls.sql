-- M6 LAB4: optional per-branch menu availability, never a payment/order schema.
BEGIN;
DO $m6_guard$
BEGIN
  IF current_database() NOT IN ('tala_restaurants_v2_lab','tala_restaurants_v2_test') THEN
    RAISE EXCEPTION 'RESTAURANTS_LAB_ONLY';
  END IF;
  IF to_regclass('tala_restaurants_v2.variants') IS NULL OR
     to_regclass('tala_restaurants_v2.branches') IS NULL THEN
    RAISE EXCEPTION 'RESTAURANTS_001_REQUIRED';
  END IF;
END $m6_guard$;

CREATE TABLE tala_restaurants_v2.branch_variant_controls (
 store_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 variant_id uuid NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,variant_id),
 FOREIGN KEY(branch_id,store_id) REFERENCES tala_restaurants_v2.branches(id,store_id)
   ON DELETE RESTRICT,
 FOREIGN KEY(variant_id,store_id) REFERENCES tala_restaurants_v2.variants(id,store_id)
   ON DELETE RESTRICT
);
CREATE INDEX ix_m6_branch_variant_enabled
 ON tala_restaurants_v2.branch_variant_controls(store_id,branch_id,enabled);
COMMIT;
