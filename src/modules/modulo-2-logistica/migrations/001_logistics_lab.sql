-- Módulo 2 — Logística. PostgreSQL 16, disposable LAB only.
-- Schema dedicated to logistics; no modifications to Orders / payments schemas.
BEGIN;
CREATE SCHEMA IF NOT EXISTS tala_logistics_v2;
CREATE TABLE tala_logistics_v2.couriers (
  id uuid PRIMARY KEY,
  zone text NOT NULL CHECK(zone ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  approved boolean NOT NULL DEFAULT false,
  online boolean NOT NULL DEFAULT false,
  capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 5),
  last_seen_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT courier_online_approved CHECK (NOT online OR approved)
);
CREATE INDEX idx_logistics_couriers_available
  ON tala_logistics_v2.couriers(zone,id) WHERE approved AND online;
CREATE TABLE tala_logistics_v2.dispatch_reservations (
  order_id uuid PRIMARY KEY,
  restaurant_id uuid NOT NULL,
  zone text NOT NULL CHECK(zone ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  courier_id uuid NOT NULL REFERENCES tala_logistics_v2.couriers(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK(status IN ('reserved','completed','released')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_logistics_dispatch_active
  ON tala_logistics_v2.dispatch_reservations(courier_id)
  WHERE status='reserved';
CREATE TABLE tala_logistics_v2.dispatch_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES tala_logistics_v2.dispatch_reservations(order_id),
  command_key text NOT NULL CHECK(length(command_key) BETWEEN 16 AND 128),
  event_type text NOT NULL CHECK(event_type IN ('dispatch.reserved','dispatch.completed','dispatch.released')),
  courier_id uuid NOT NULL,
  event_key text NOT NULL UNIQUE CHECK(event_key ~ '^[a-f0-9]{64}$'),
  details jsonb NOT NULL CHECK(jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(order_id,command_key)
);
CREATE TABLE tala_logistics_v2.outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE REFERENCES tala_logistics_v2.dispatch_events(event_key),
  event_type text NOT NULL CHECK(event_type IN ('dispatch.reserved','dispatch.completed','dispatch.released')),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz
);
CREATE OR REPLACE FUNCTION tala_logistics_v2.prevent_event_changes()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LOGISTICS_EVENT_APPEND_ONLY' USING ERRCODE='23514';
END;$$;
CREATE TRIGGER trg_logistics_event_immutable
  BEFORE UPDATE OR DELETE ON tala_logistics_v2.dispatch_events
  FOR EACH ROW EXECUTE FUNCTION tala_logistics_v2.prevent_event_changes();
COMMIT;
