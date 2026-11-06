-- Tala Eats Core v2 — M10 Analytics, independent LAB1 schema.
BEGIN;
DO $m10$
BEGIN
 IF current_database() NOT IN ('tala_analytics_v2_test','tala_analytics_v2_lab') THEN
  RAISE EXCEPTION 'ANALYTICS_LAB_ONLY';
 END IF;
END $m10$;
CREATE SCHEMA tala_analytics_v2;

-- Event IDs are stable across retries and business facts have additional
-- unique IDs; consumers cannot manufacture metrics by changing event IDs.
CREATE TABLE tala_analytics_v2.ingested_events(
 event_id uuid PRIMARY KEY,
 issuer text NOT NULL CHECK (issuer IN ('orders','payments','logistics')),
 kind text NOT NULL CHECK (kind IN ('order.completed','order.canceled',
  'payment.confirmed','refund.confirmed','delivery.completed')),
 merchant_id uuid NOT NULL,
 order_id uuid NOT NULL,
 refund_id uuid,
 amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 0 AND 100000000),
 occurred_at timestamptz NOT NULL,
 event_day date NOT NULL,
 payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
 ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((kind='refund.confirmed')=(refund_id IS NOT NULL)),
 CHECK ((kind IN ('order.canceled','delivery.completed'))=(amount_cents=0))
);
CREATE INDEX ix_m10_ingested_time ON tala_analytics_v2.ingested_events(ingested_at DESC);

CREATE TABLE tala_analytics_v2.order_outcomes(
 order_id uuid PRIMARY KEY,
 merchant_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('order.completed','order.canceled')),
 amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 0 AND 100000000),
 event_id uuid NOT NULL UNIQUE REFERENCES tala_analytics_v2.ingested_events(event_id)
);
CREATE TABLE tala_analytics_v2.payment_facts(
 order_id uuid PRIMARY KEY,
 merchant_id uuid NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 event_id uuid NOT NULL UNIQUE REFERENCES tala_analytics_v2.ingested_events(event_id)
);
CREATE TABLE tala_analytics_v2.refund_facts(
 refund_id uuid PRIMARY KEY,
 order_id uuid NOT NULL,
 merchant_id uuid NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
 event_id uuid NOT NULL UNIQUE REFERENCES tala_analytics_v2.ingested_events(event_id)
);
CREATE INDEX ix_m10_refund_order ON tala_analytics_v2.refund_facts(order_id);
CREATE TABLE tala_analytics_v2.delivery_facts(
 order_id uuid PRIMARY KEY,
 merchant_id uuid NOT NULL,
 event_id uuid NOT NULL UNIQUE REFERENCES tala_analytics_v2.ingested_events(event_id)
);

-- Derived analytical counters are never a substitute for M3 double-entry
-- bookkeeping, PSP settlement or paid merchant wallets.
CREATE TABLE tala_analytics_v2.daily_merchant_metrics(
 merchant_id uuid NOT NULL,
 event_day date NOT NULL,
 orders_completed bigint NOT NULL DEFAULT 0 CHECK(orders_completed>=0),
 orders_canceled bigint NOT NULL DEFAULT 0 CHECK(orders_canceled>=0),
 deliveries_completed bigint NOT NULL DEFAULT 0 CHECK(deliveries_completed>=0),
 payments_confirmed bigint NOT NULL DEFAULT 0 CHECK(payments_confirmed>=0),
 refunds_confirmed bigint NOT NULL DEFAULT 0 CHECK(refunds_confirmed>=0),
 order_gmv_cents bigint NOT NULL DEFAULT 0 CHECK(order_gmv_cents>=0),
 payments_cents bigint NOT NULL DEFAULT 0 CHECK(payments_cents>=0),
 refunds_cents bigint NOT NULL DEFAULT 0 CHECK(refunds_cents>=0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(merchant_id,event_day)
);
CREATE INDEX ix_m10_daily_date ON tala_analytics_v2.daily_merchant_metrics(event_day);

CREATE OR REPLACE FUNCTION tala_analytics_v2.reject_fact_mutation()
RETURNS trigger LANGUAGE plpgsql AS $immutable$
BEGIN
 RAISE EXCEPTION 'ANALYTICS_FACT_IMMUTABLE' USING ERRCODE='23514';
END $immutable$;
CREATE TRIGGER trg_m10_events_immutable BEFORE UPDATE OR DELETE
 ON tala_analytics_v2.ingested_events FOR EACH ROW
 EXECUTE FUNCTION tala_analytics_v2.reject_fact_mutation();
CREATE TRIGGER trg_m10_order_facts_immutable BEFORE UPDATE OR DELETE
 ON tala_analytics_v2.order_outcomes FOR EACH ROW
 EXECUTE FUNCTION tala_analytics_v2.reject_fact_mutation();
CREATE TRIGGER trg_m10_payment_facts_immutable BEFORE UPDATE OR DELETE
 ON tala_analytics_v2.payment_facts FOR EACH ROW
 EXECUTE FUNCTION tala_analytics_v2.reject_fact_mutation();
CREATE TRIGGER trg_m10_refund_facts_immutable BEFORE UPDATE OR DELETE
 ON tala_analytics_v2.refund_facts FOR EACH ROW
 EXECUTE FUNCTION tala_analytics_v2.reject_fact_mutation();
CREATE TRIGGER trg_m10_delivery_facts_immutable BEFORE UPDATE OR DELETE
 ON tala_analytics_v2.delivery_facts FOR EACH ROW
 EXECUTE FUNCTION tala_analytics_v2.reject_fact_mutation();
COMMIT;
