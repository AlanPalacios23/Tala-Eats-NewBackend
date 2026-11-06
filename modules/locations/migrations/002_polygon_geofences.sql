-- M7 LAB2: isolated operator-defined polygon geofences (not street deliverability).
BEGIN;
DO $guard$
BEGIN
  IF current_database() NOT IN ('tala_locations_v2_test','tala_locations_v2_lab') THEN
    RAISE EXCEPTION 'LOCATIONS_LAB_ONLY';
  END IF;
  IF to_regclass('tala_locations_v2.coverage_zones') IS NULL THEN
    RAISE EXCEPTION 'LOCATIONS_001_REQUIRED';
  END IF;
END $guard$;

CREATE TABLE tala_locations_v2.polygon_zones (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 slug text NOT NULL UNIQUE
   CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug)<=60),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 100),
 city text NOT NULL CHECK(city IN
  ('tala','ameca','ahualulco','tequila','cuisillos','amatitan')),
 -- All boundary validation (self-intersection, area and span) is performed
 -- in the M7 domain layer, not inferred from a city label.
 vertices jsonb NOT NULL
   CHECK(jsonb_typeof(vertices)='array' AND jsonb_array_length(vertices) BETWEEN 3 AND 64),
 status text NOT NULL DEFAULT 'draft'
   CHECK(status IN ('draft','active','disabled')),
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_m7_polygon_active_city
 ON tala_locations_v2.polygon_zones(city,status,slug);
COMMIT;
