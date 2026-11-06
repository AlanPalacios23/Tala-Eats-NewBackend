-- M11 LAB6 extension owned by integration, physically stored in M6 LAB database.
-- Explicit, temporary M6 boundary extension; no original M6 subtree changed.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_restaurants_v2_test','tala_restaurants_v2_lab') THEN
  RAISE EXCEPTION 'RESTAURANTS_LAB_ONLY';
 END IF;
 IF to_regclass('tala_restaurants_v2.branch_stock') IS NULL THEN
  RAISE EXCEPTION 'RESTAURANTS_005_REQUIRED';
 END IF;
END $guard$;

CREATE TABLE tala_restaurants_v2.order_stock_holds (
 hold_id uuid PRIMARY KEY,
 store_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'reserved'
   CHECK(state IN ('reserved','confirmed','released')),
 m1_order_id uuid UNIQUE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(branch_id,store_id)
  REFERENCES tala_restaurants_v2.branches(id,store_id),
 CHECK ((state='confirmed')=(m1_order_id IS NOT NULL))
);
CREATE INDEX ix_m11_hold_expiry
 ON tala_restaurants_v2.order_stock_holds(expires_at,hold_id)
 WHERE state='reserved';
CREATE TABLE tala_restaurants_v2.order_stock_hold_lines (
 hold_id uuid NOT NULL REFERENCES tala_restaurants_v2.order_stock_holds(hold_id),
 line_no smallint NOT NULL CHECK(line_no BETWEEN 1 AND 50),
 variant_id uuid NOT NULL,
 store_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100),
 variant_version integer NOT NULL CHECK(variant_version>0),
 price_minor bigint NOT NULL CHECK(price_minor BETWEEN 1 AND 100000000),
 name_snapshot text NOT NULL CHECK(length(name_snapshot) BETWEEN 3 AND 240),
 weight_grams integer,
 stock_before integer NOT NULL CHECK(stock_before BETWEEN 0 AND 1000000),
 stock_after integer NOT NULL CHECK(stock_after BETWEEN 0 AND 1000000),
 PRIMARY KEY(hold_id,line_no),
 UNIQUE(hold_id,variant_id),
 FOREIGN KEY(branch_id,variant_id)
  REFERENCES tala_restaurants_v2.branch_stock(branch_id,variant_id),
 CHECK(stock_before-stock_after=quantity)
);

CREATE TABLE tala_restaurants_v2.order_stock_hold_events (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 hold_id uuid NOT NULL REFERENCES tala_restaurants_v2.order_stock_holds(hold_id),
 event_type text NOT NULL CHECK(event_type IN
  ('inventory.reserved','inventory.confirmed','inventory.released')),
 order_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(hold_id,event_type),
 CHECK ((event_type='inventory.confirmed')=(order_id IS NOT NULL))
);
CREATE INDEX ix_m11_m6_hold_events_pending
 ON tala_restaurants_v2.order_stock_hold_events(created_at,event_id);
CREATE TRIGGER trg_m11_hold_lines_immutable
 BEFORE UPDATE OR DELETE ON tala_restaurants_v2.order_stock_hold_lines
 FOR EACH ROW EXECUTE FUNCTION tala_restaurants_v2.prevent_stock_history_mutation();
CREATE TRIGGER trg_m11_hold_events_immutable
 BEFORE UPDATE OR DELETE ON tala_restaurants_v2.order_stock_hold_events
 FOR EACH ROW EXECUTE FUNCTION tala_restaurants_v2.prevent_stock_history_mutation();
COMMIT;
