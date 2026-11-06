-- M6 LAB5: opt-in per-branch physical stock, not order reservations.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_restaurants_v2_test','tala_restaurants_v2_lab') THEN
   RAISE EXCEPTION 'RESTAURANTS_LAB_ONLY';
 END IF;
 IF to_regclass('tala_restaurants_v2.branch_variant_controls') IS NULL THEN
   RAISE EXCEPTION 'RESTAURANTS_004_REQUIRED';
 END IF;
END $guard$;
ALTER TABLE tala_restaurants_v2.variants
 ADD COLUMN branch_stock_enabled boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT ck_m6_branch_stock_migration CHECK
   (NOT branch_stock_enabled OR (track_stock AND stock_quantity=0));

CREATE TABLE tala_restaurants_v2.branch_stock (
 store_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 variant_id uuid NOT NULL,
 quantity integer NOT NULL DEFAULT 0 CHECK(quantity BETWEEN 0 AND 1000000),
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,variant_id),
 FOREIGN KEY(branch_id,store_id)
  REFERENCES tala_restaurants_v2.branches(id,store_id) ON DELETE RESTRICT,
 FOREIGN KEY(variant_id,store_id)
  REFERENCES tala_restaurants_v2.variants(id,store_id) ON DELETE RESTRICT
);
CREATE INDEX ix_m6_branch_stock_store
 ON tala_restaurants_v2.branch_stock(store_id,branch_id,variant_id);
CREATE TABLE tala_restaurants_v2.branch_stock_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 variant_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 delta integer NOT NULL CHECK(delta BETWEEN -1000000 AND 1000000 AND delta<>0),
 quantity_before integer NOT NULL CHECK(quantity_before BETWEEN 0 AND 1000000),
 quantity_after integer NOT NULL CHECK(quantity_after BETWEEN 0 AND 1000000),
 reason text NOT NULL CHECK(
   (reason='restock' AND delta>0) OR
   (reason='waste' AND delta<0) OR
   (reason='correction' AND delta<>0)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,variant_id) REFERENCES
  tala_restaurants_v2.branch_stock(branch_id,variant_id) ON DELETE RESTRICT,
 FOREIGN KEY(branch_id,store_id) REFERENCES
  tala_restaurants_v2.branches(id,store_id) ON DELETE RESTRICT,
 UNIQUE(store_id,operation_id)
);
CREATE INDEX ix_m6_branch_stock_history ON
 tala_restaurants_v2.branch_stock_adjustments(branch_id,variant_id,created_at DESC);
CREATE TRIGGER trg_m6_immutable_branch_stock BEFORE UPDATE OR DELETE
 ON tala_restaurants_v2.branch_stock_adjustments FOR EACH ROW
 EXECUTE FUNCTION tala_restaurants_v2.prevent_stock_history_mutation();
COMMIT;
