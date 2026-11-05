-- CORE v2 PEDIDOS: harden order-owned snapshots and historical line items.
-- Apply AFTER 001..004, only on disposable LOCAL LAB database.
-- Never run on existing production/legacy stores.
BEGIN;

-- A sold catalog product must remain referentially addressable for cash
-- cancellation. Merchants should deactivate it, never DELETE historical SKUs.
ALTER TABLE tala_core_v2.order_lines
  ADD CONSTRAINT order_lines_catalog_product_fk
  FOREIGN KEY (product_id) REFERENCES tala_core_v2.catalog_products(id)
  ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION tala_core_v2.prevent_order_line_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ORDER_LINE_SNAPSHOT_IMMUTABLE' USING ERRCODE='23514';
END;$$;
DROP TRIGGER IF EXISTS trg_order_line_immutable ON tala_core_v2.order_lines;
CREATE TRIGGER trg_order_line_immutable
  BEFORE UPDATE OR DELETE ON tala_core_v2.order_lines
  FOR EACH ROW EXECUTE FUNCTION tala_core_v2.prevent_order_line_mutation();

CREATE OR REPLACE FUNCTION tala_core_v2.prevent_order_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
    OR NEW.restaurant_id IS DISTINCT FROM OLD.restaurant_id
    OR NEW.fulfillment IS DISTINCT FROM OLD.fulfillment
    OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
    OR NEW.pricing_policy_version IS DISTINCT FROM OLD.pricing_policy_version
    OR NEW.price_snapshot IS DISTINCT FROM OLD.price_snapshot
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
    RAISE EXCEPTION 'ORDER_SNAPSHOT_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS trg_order_snapshot_immutable ON tala_core_v2.orders;
CREATE TRIGGER trg_order_snapshot_immutable
  BEFORE UPDATE ON tala_core_v2.orders
  FOR EACH ROW EXECUTE FUNCTION tala_core_v2.prevent_order_snapshot_mutation();

-- Preserve the money attributed at checkout; no actor can silently rewrite
-- a handoff's amount while its state/proofs change.
CREATE OR REPLACE FUNCTION tala_core_v2.prevent_handoff_amount_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cash_amount_minor IS DISTINCT FROM OLD.cash_amount_minor
    OR NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'HANDOFF_AMOUNT_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS trg_handoff_amount_immutable ON tala_core_v2.order_handoffs;
CREATE TRIGGER trg_handoff_amount_immutable
  BEFORE UPDATE ON tala_core_v2.order_handoffs
  FOR EACH ROW EXECUTE FUNCTION tala_core_v2.prevent_handoff_amount_mutation();

COMMIT;
