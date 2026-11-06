-- M11: isolated, durable inter-module event transport. LAB only.
-- No foreign keys to other module schemas; no payments, wallets or PII.
BEGIN;
DO $m11$
BEGIN
 IF current_database() NOT IN
   ('tala_integration_v2_test','tala_integration_v2_lab')
 THEN RAISE EXCEPTION 'M11_LAB_DATABASE_ONLY';
 END IF;
END $m11$;
CREATE SCHEMA tala_integration_v2;

CREATE TABLE tala_integration_v2.inbox_events (
 event_id uuid PRIMARY KEY,
 issuer text NOT NULL CHECK (issuer IN ('orders','payments','logistics')),
 kind text NOT NULL CHECK(kind IN
   ('order.completed','order.canceled','payment.confirmed',
    'refund.confirmed','delivery.completed')),
 merchant_id uuid NOT NULL,
 order_id uuid NOT NULL,
 refund_id uuid,
 amount_cents bigint NOT NULL
   CHECK(amount_cents BETWEEN 0 AND 100000000),
 occurred_at timestamptz NOT NULL,
 event_day date NOT NULL,
 payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((kind='refund.confirmed')=(refund_id IS NOT NULL)),
 CHECK ((kind IN ('order.canceled','delivery.completed'))=(amount_cents=0)),
 CHECK ((kind IN ('order.completed','payment.confirmed','refund.confirmed'))=
   (amount_cents>0))
);
-- Immutable business identity. A second event ID must never create
-- another delivery or payment for the same fact.
CREATE UNIQUE INDEX ux_m11_order_fact
 ON tala_integration_v2.inbox_events(kind,order_id)
 WHERE kind<>'refund.confirmed';
CREATE UNIQUE INDEX ux_m11_refund_fact
 ON tala_integration_v2.inbox_events(refund_id)
 WHERE refund_id IS NOT NULL;
CREATE INDEX ix_m11_inbox_at
 ON tala_integration_v2.inbox_events(received_at);

CREATE TABLE tala_integration_v2.dispatch_jobs (
 event_id uuid NOT NULL REFERENCES tala_integration_v2.inbox_events(event_id),
 consumer text NOT NULL CHECK(consumer IN ('finance','notifications','analytics')),
 status text NOT NULL DEFAULT 'pending'
  CHECK(status IN ('pending','leased','applied','dead')),
 attempts integer NOT NULL DEFAULT 0
  CHECK(attempts BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_token uuid,
 leased_until timestamptz,
 applied_at timestamptz,
 failure_code text,
 PRIMARY KEY(event_id,consumer),
 CHECK(
  (status='leased' AND lease_token IS NOT NULL AND leased_until IS NOT NULL)
  OR
  (status<>'leased' AND lease_token IS NULL AND leased_until IS NULL)
 ),
 CHECK ((status='applied')=(applied_at IS NOT NULL))
);
CREATE INDEX ix_m11_jobs_ready ON tala_integration_v2.dispatch_jobs
 (consumer,available_at,event_id)
 WHERE status IN ('pending','leased');

CREATE OR REPLACE FUNCTION tala_integration_v2.reject_inbox_mutation()
RETURNS trigger LANGUAGE plpgsql AS $immutable$
BEGIN
 RAISE EXCEPTION 'M11_IMMUTABLE_EVENT' USING ERRCODE='23514';
END $immutable$;
CREATE TRIGGER m11_inbox_append_only BEFORE UPDATE OR DELETE ON
 tala_integration_v2.inbox_events FOR EACH ROW
 EXECUTE FUNCTION tala_integration_v2.reject_inbox_mutation();
COMMIT;
