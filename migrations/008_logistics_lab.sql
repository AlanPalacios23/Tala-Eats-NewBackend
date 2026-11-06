-- TALA EATS CORE v2 / Module 2 Logistics LAB1 only.
-- AFTER migrations 001-007 on a disposable LOCAL database. NEVER Kali/LIVE.
BEGIN;
ALTER TABLE tala_core_v2.driver_profiles
  ADD COLUMN presence_version bigint NOT NULL DEFAULT 1 CHECK (presence_version>=1),
  ADD COLUMN presence_updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN max_active_deliveries integer NOT NULL DEFAULT 1
    CHECK (max_active_deliveries=1);
-- No multi-drop routing yet: fail closed with exactly one active assignment.
CREATE TABLE tala_core_v2.driver_presence_commands (
  driver_id uuid NOT NULL REFERENCES tala_core_v2.driver_profiles(account_id),
  command_hash text NOT NULL CHECK (command_hash ~ '^[a-f0-9]{64}$'),
  expected_version bigint NOT NULL CHECK (expected_version>=1),
  result_version bigint NOT NULL CHECK (result_version>=2),
  desired_online boolean NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(driver_id,command_hash)
);
CREATE TABLE tala_core_v2.driver_latest_locations (
  driver_id uuid PRIMARY KEY REFERENCES tala_core_v2.driver_profiles(account_id),
  latitude_micro integer NOT NULL CHECK (latitude_micro BETWEEN -90000000 AND 90000000),
  longitude_micro integer NOT NULL CHECK (longitude_micro BETWEEN -180000000 AND 180000000),
  accuracy_m integer NOT NULL CHECK (accuracy_m BETWEEN 1 AND 100),
  sequence bigint NOT NULL CHECK (sequence>0),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK (observed_at <= received_at + interval '15 seconds')
);
-- Recorded presence commands are immutable audit evidence (location is only
-- latest-state and can be overwritten; no GPS trail is stored).
CREATE TRIGGER trg_driver_presence_commands_immutable
  BEFORE UPDATE OR DELETE ON tala_core_v2.driver_presence_commands
  FOR EACH ROW EXECUTE FUNCTION tala_core_v2.prevent_event_mutation();
COMMIT;
