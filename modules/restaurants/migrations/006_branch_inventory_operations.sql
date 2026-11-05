-- M6 LAB6: merchant-only physical transfers and counted inventory.
-- No orders, payments, delivery allocations, or references to other schemas.
BEGIN;
DO $guard$
BEGIN
  IF current_database() NOT IN ('tala_restaurants_v2_test','tala_restaurants_v2_lab')
    THEN RAISE EXCEPTION 'RESTAURANTS_LAB_ONLY';
  END IF;
  IF to_regclass('tala_restaurants_v2.branch_stock_adjustments') IS NULL
    THEN RAISE EXCEPTION 'RESTAURANTS_005_REQUIRED';
  END IF;
END $guard$;

CREATE TABLE tala_restaurants_v2.branch_stock_transfers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_id uuid NOT NULL,
 from_branch_id uuid NOT NULL,
 to_branch_id uuid NOT NULL,
 variant_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 1000000),
 source_before integer NOT NULL CHECK(source_before BETWEEN 0 AND 1000000),
 source_after integer NOT NULL CHECK(source_after BETWEEN 0 AND 1000000),
 destination_before integer NOT NULL CHECK(destination_before BETWEEN 0 AND 1000000),
 destination_after integer NOT NULL CHECK(destination_after BETWEEN 0 AND 1000000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(from_branch_id,store_id) REFERENCES tala_restaurants_v2.branches(id,store_id),
 FOREIGN KEY(to_branch_id,store_id) REFERENCES tala_restaurants_v2.branches(id,store_id),
 FOREIGN KEY(from_branch_id,variant_id) REFERENCES tala_restaurants_v2.branch_stock(branch_id,variant_id),
 FOREIGN KEY(to_branch_id,variant_id) REFERENCES tala_restaurants_v2.branch_stock(branch_id,variant_id),
 CONSTRAINT ck_m6_transfer_distinct CHECK(from_branch_id<>to_branch_id),
 CONSTRAINT ck_m6_transfer_balanced CHECK(
   source_before-source_after=quantity AND
   destination_after-destination_before=quantity),
 UNIQUE(store_id,operation_id)
);
CREATE INDEX ix_m6_transfers_source ON tala_restaurants_v2.branch_stock_transfers
 (store_id,from_branch_id,created_at DESC);
CREATE INDEX ix_m6_transfers_dest ON tala_restaurants_v2.branch_stock_transfers
 (store_id,to_branch_id,created_at DESC);

CREATE TABLE tala_restaurants_v2.branch_stock_counts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 variant_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 expected_version integer NOT NULL CHECK(expected_version>=0),
 quantity_before integer NOT NULL CHECK(quantity_before BETWEEN 0 AND 1000000),
 counted_quantity integer NOT NULL CHECK(counted_quantity BETWEEN 0 AND 1000000),
 delta integer NOT NULL CHECK(delta BETWEEN -1000000 AND 1000000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,store_id) REFERENCES tala_restaurants_v2.branches(id,store_id),
 FOREIGN KEY(branch_id,variant_id) REFERENCES tala_restaurants_v2.branch_stock(branch_id,variant_id),
 CONSTRAINT ck_m6_count_delta CHECK(counted_quantity-quantity_before=delta),
 UNIQUE(store_id,operation_id)
);
CREATE INDEX ix_m6_counts_branch ON tala_restaurants_v2.branch_stock_counts
 (store_id,branch_id,created_at DESC);

CREATE TRIGGER trg_m6_immutable_transfers BEFORE UPDATE OR DELETE
 ON tala_restaurants_v2.branch_stock_transfers FOR EACH ROW
 EXECUTE FUNCTION tala_restaurants_v2.prevent_stock_history_mutation();
CREATE TRIGGER trg_m6_immutable_counts BEFORE UPDATE OR DELETE
 ON tala_restaurants_v2.branch_stock_counts FOR EACH ROW
 EXECUTE FUNCTION tala_restaurants_v2.prevent_stock_history_mutation();
COMMIT;
