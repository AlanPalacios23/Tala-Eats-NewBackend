-- Forward-only order integrity hardening. LAB DATABASE ONLY, after 001-006.
-- Do not run in LIVE or shared PostgreSQL.
BEGIN;

-- Delivery address is part of the purchase agreement and must not be
-- silently redirected after the buyer commits the checkout.
CREATE OR REPLACE FUNCTION tala_core_v2.prevent_order_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.buyer_id IS DISTINCT FROM OLD.buyer_id
    OR NEW.restaurant_id IS DISTINCT FROM OLD.restaurant_id
    OR NEW.fulfillment IS DISTINCT FROM OLD.fulfillment
    OR NEW.delivery_address IS DISTINCT FROM OLD.delivery_address
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

-- Evidence timestamps and the identity of the cash receiver are write-once.
-- Successful delivery consumes the PIN; no future SQL update can clear it
-- or mutate the PIN fields after consumption.
CREATE OR REPLACE FUNCTION tala_core_v2.prevent_handoff_proof_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.buyer_cash_ack_at IS NOT NULL AND
      NEW.buyer_cash_ack_at IS DISTINCT FROM OLD.buyer_cash_ack_at)
    OR (OLD.custodian_cash_ack_at IS NOT NULL AND
      NEW.custodian_cash_ack_at IS DISTINCT FROM OLD.custodian_cash_ack_at)
    OR (OLD.custodian_id IS NOT NULL AND
      NEW.custodian_id IS DISTINCT FROM OLD.custodian_id)
    OR (OLD.custodian_role IS NOT NULL AND
      NEW.custodian_role IS DISTINCT FROM OLD.custodian_role)
    OR (OLD.pin_consumed_at IS NOT NULL AND
      (NEW.pin_consumed_at IS DISTINCT FROM OLD.pin_consumed_at
        OR NEW.pin_hash IS DISTINCT FROM OLD.pin_hash
        OR NEW.pin_salt IS DISTINCT FROM OLD.pin_salt
        OR NEW.pin_expires_at IS DISTINCT FROM OLD.pin_expires_at)) THEN
    RAISE EXCEPTION 'ORDER_HANDOFF_PROOF_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS trg_order_handoff_proof_immutable ON tala_core_v2.order_handoffs;
CREATE TRIGGER trg_order_handoff_proof_immutable
  BEFORE UPDATE ON tala_core_v2.order_handoffs
  FOR EACH ROW EXECUTE FUNCTION tala_core_v2.prevent_handoff_proof_mutation();

COMMIT;
