-- M6 LAB2 inventory hardening. Append-only adjustments; meaningful signs.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_restaurants_v2_test','tala_restaurants_v2_lab') THEN
   RAISE EXCEPTION 'RESTAURANTS_LAB_ONLY';
 END IF;
 IF to_regclass('tala_restaurants_v2.stock_adjustments') IS NULL THEN
   RAISE EXCEPTION 'RESTAURANTS_001_REQUIRED';
 END IF;
END $guard$;
ALTER TABLE tala_restaurants_v2.stock_adjustments
 ADD CONSTRAINT ck_m6_stock_reason_direction CHECK(
   (reason='restock' AND delta>0)
   OR (reason='waste' AND delta<0)
   OR (reason='correction' AND delta<>0)
 );
CREATE FUNCTION tala_restaurants_v2.prevent_stock_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
 RAISE EXCEPTION 'RESTAURANTS_STOCK_HISTORY_IMMUTABLE' USING ERRCODE='23514';
END $fn$;
CREATE TRIGGER trg_m6_immutable_stock BEFORE UPDATE OR DELETE
ON tala_restaurants_v2.stock_adjustments FOR EACH ROW
EXECUTE FUNCTION tala_restaurants_v2.prevent_stock_history_mutation();
COMMIT;
