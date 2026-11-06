-- Run ONLY against the isolated tala_core_v2 database, NEVER a LIVE database.
-- PostgreSQL 15+. Monolithic backend; modules share a single transaction boundary.
BEGIN;
CREATE SCHEMA IF NOT EXISTS tala_core_v2;

CREATE TABLE IF NOT EXISTS tala_core_v2.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL,
  restaurant_id uuid NOT NULL,
  fulfillment text NOT NULL CHECK (fulfillment IN ('pickup','delivery')),
  status text NOT NULL DEFAULT 'awaiting_payment'
    CHECK (status IN ('awaiting_payment','received','confirmed','preparing','ready',
      'assigned','picked_up','on_the_way','delivered','cancelled')),
  payment_method text NOT NULL CHECK (payment_method IN ('cash','stripe')),
  payment_status text NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending','paid','refunded','failed')),
  currency text NOT NULL DEFAULT 'MXN' CHECK (currency='MXN'),
  total_minor bigint NOT NULL CHECK (total_minor>0),
  pricing_policy_version text NOT NULL,
  price_snapshot jsonb NOT NULL CHECK (jsonb_typeof(price_snapshot)='object'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS tala_core_v2.order_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES tala_core_v2.orders(id),
  line_number integer NOT NULL CHECK (line_number>0),
  product_id uuid NOT NULL,
  product_name_snapshot text NOT NULL,
  unit_minor bigint NOT NULL CHECK (unit_minor>=0),
  quantity integer NOT NULL CHECK (quantity>0),
  UNIQUE (order_id,line_number)
);

CREATE TABLE IF NOT EXISTS tala_core_v2.order_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES tala_core_v2.orders(id),
  event_key text NOT NULL CHECK (char_length(event_key) BETWEEN 16 AND 128),
  previous_status text,
  new_status text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('system','merchant','driver','admin')),
  actor_id uuid,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id,event_key)
);

CREATE TABLE IF NOT EXISTS tala_core_v2.outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_id uuid NOT NULL,
  event_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count>=0)
);

CREATE INDEX IF NOT EXISTS idx_core_orders_restaurant_state
  ON tala_core_v2.orders(restaurant_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_core_orders_buyer_created
  ON tala_core_v2.orders(buyer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_core_outbox_unprocessed
  ON tala_core_v2.outbox(created_at,id) WHERE processed_at IS NULL;

-- Evidence events are append-only; correcting mistakes requires a new event.
CREATE OR REPLACE FUNCTION tala_core_v2.prevent_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ORDER_EVENT_APPEND_ONLY';
END;$$;
DROP TRIGGER IF EXISTS trg_order_event_immutable ON tala_core_v2.order_events;
CREATE TRIGGER trg_order_event_immutable
  BEFORE UPDATE OR DELETE ON tala_core_v2.order_events
  FOR EACH ROW EXECUTE FUNCTION tala_core_v2.prevent_event_mutation();

COMMIT;
