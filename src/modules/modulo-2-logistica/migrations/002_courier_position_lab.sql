-- Module 2 lab-only: latest position (not a tracking history), no buyer GPS.
BEGIN;
CREATE TABLE tala_logistics_v2.courier_positions (
 courier_id uuid PRIMARY KEY REFERENCES tala_logistics_v2.couriers(id) ON DELETE CASCADE,
 latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
 longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 accuracy_m double precision NOT NULL CHECK(accuracy_m BETWEEN 0 AND 100),
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_logistics_position_fresh ON tala_logistics_v2.courier_positions(observed_at);
-- Eliminar último punto al desconectar o revocar al conductor.
CREATE FUNCTION tala_logistics_v2.purge_offline_position()
RETURNS trigger LANGUAGE plpgsql AS $gps$
BEGIN
  IF NOT NEW.online OR NOT NEW.approved THEN
    DELETE FROM tala_logistics_v2.courier_positions WHERE courier_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$gps$;
CREATE TRIGGER trg_logistics_purge_offline_position
AFTER UPDATE OF online,approved ON tala_logistics_v2.couriers
FOR EACH ROW WHEN (NOT NEW.online OR NOT NEW.approved)
EXECUTE FUNCTION tala_logistics_v2.purge_offline_position();
COMMIT;
