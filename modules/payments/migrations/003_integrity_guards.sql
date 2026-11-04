-- M8 LAB3: fail-closed core payment and refund integrity at the SQL boundary.
-- Distinct from provider event/fact append-only triggers in migrations 001/002.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_payments_v2_test','tala_payments_v2_lab') THEN
  RAISE EXCEPTION 'PAYMENTS_LAB_ONLY';
 END IF;
 IF to_regclass('tala_payments_v2.stripe_test_intents') IS NULL THEN
  RAISE EXCEPTION 'M8_MIGRATION_002_REQUIRED';
 END IF;
END $guard$;

CREATE OR REPLACE FUNCTION tala_payments_v2.guard_payment_integrity()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.provider<>'simulated_lab' OR NEW.state<>'pending' OR
     NEW.provider_ref IS NOT NULL OR NEW.version<>1 THEN
   RAISE EXCEPTION 'M8_PAYMENT_INITIAL_STATE_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF ROW(NEW.id,NEW.order_ref,NEW.customer_ref,NEW.amount_cents,
        NEW.currency,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id,OLD.order_ref,OLD.customer_ref,OLD.amount_cents,
        OLD.currency,OLD.created_at) THEN
  RAISE EXCEPTION 'M8_PAYMENT_CORE_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF NEW.version<>OLD.version+1 THEN
  RAISE EXCEPTION 'M8_PAYMENT_VERSION_INVALID' USING ERRCODE='23514';
 END IF;
 IF NEW.provider<>OLD.provider AND NOT (
    OLD.provider='simulated_lab' AND NEW.provider='stripe_test'
    AND OLD.state='pending' AND NEW.state='pending'
    AND OLD.provider_ref IS NULL AND NEW.provider_ref IS NULL) THEN
  RAISE EXCEPTION 'M8_PAYMENT_PROVIDER_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF OLD.provider_ref IS NOT NULL AND
    NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
  RAISE EXCEPTION 'M8_PAYMENT_PROVIDER_REFERENCE_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF NEW.provider='stripe_test' AND NEW.provider_ref IS NOT NULL
    AND NEW.provider_ref !~ '^pi_[A-Za-z0-9]{4,128}$' THEN
  RAISE EXCEPTION 'M8_PAYMENT_STRIPE_REF_INVALID' USING ERRCODE='23514';
 END IF;
 IF NEW.provider='simulated_lab' AND NEW.provider_ref IS NOT NULL
    AND NEW.provider_ref !~ '^lab_[a-z0-9_]{6,75}$' THEN
  RAISE EXCEPTION 'M8_PAYMENT_LAB_REF_INVALID' USING ERRCODE='23514';
 END IF;
 IF NEW.state<>OLD.state AND NOT (
    OLD.state='pending' AND NEW.state IN ('succeeded','failed','canceled')) THEN
  RAISE EXCEPTION 'M8_PAYMENT_TERMINAL_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;

CREATE TRIGGER trg_m8_payment_integrity
 BEFORE INSERT OR UPDATE ON tala_payments_v2.payments
 FOR EACH ROW EXECUTE FUNCTION tala_payments_v2.guard_payment_integrity();

CREATE OR REPLACE FUNCTION tala_payments_v2.guard_refund_integrity()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE authorized_amount bigint;
DECLARE payment_state text;
DECLARE reserved_amount bigint;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'requested' OR NEW.provider_ref IS NOT NULL OR NEW.version<>1 THEN
   RAISE EXCEPTION 'M8_REFUND_INITIAL_STATE_INVALID' USING ERRCODE='23514';
  END IF;
 ELSE
  IF ROW(NEW.id,NEW.payment_id,NEW.amount_cents,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.payment_id,OLD.amount_cents,OLD.created_at) THEN
   RAISE EXCEPTION 'M8_REFUND_CORE_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF NEW.version<>OLD.version+1 THEN
   RAISE EXCEPTION 'M8_REFUND_VERSION_INVALID' USING ERRCODE='23514';
  END IF;
  IF NEW.state<>OLD.state AND NOT (
     OLD.state='requested' AND NEW.state IN ('succeeded','failed')) THEN
   RAISE EXCEPTION 'M8_REFUND_TERMINAL_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  IF OLD.provider_ref IS NOT NULL AND
     NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
   RAISE EXCEPTION 'M8_REFUND_PROVIDER_REFERENCE_IMMUTABLE' USING ERRCODE='23514';
  END IF;
 END IF;
 -- Serializable allocation-by-parent row lock even for direct SQL writes.
 SELECT amount_cents,state INTO authorized_amount,payment_state
 FROM tala_payments_v2.payments WHERE id=NEW.payment_id FOR UPDATE;
 IF NOT FOUND OR payment_state<>'succeeded' THEN
  RAISE EXCEPTION 'M8_REFUND_PAYMENT_NOT_SETTLED' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(sum(amount_cents),0) INTO reserved_amount
 FROM tala_payments_v2.refunds
 WHERE payment_id=NEW.payment_id AND state IN ('requested','succeeded')
  AND id<>NEW.id;
 IF NEW.state IN ('requested','succeeded')
    AND reserved_amount+NEW.amount_cents>authorized_amount THEN
  RAISE EXCEPTION 'M8_REFUND_EXCEEDS_PAYMENT' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;

CREATE TRIGGER trg_m8_refund_integrity
 BEFORE INSERT OR UPDATE ON tala_payments_v2.refunds
 FOR EACH ROW EXECUTE FUNCTION tala_payments_v2.guard_refund_integrity();
COMMIT;
