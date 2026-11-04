-- M6 LAB8: merchant-owned split/overnight schedules and static prep configuration.
-- DB guard: NO updates to other modules or LIVE databases.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_restaurants_v2_test','tala_restaurants_v2_lab') THEN
   RAISE EXCEPTION 'RESTAURANTS_LAB_ONLY';
 END IF;
 IF to_regclass('tala_restaurants_v2.hours') IS NULL
    OR to_regclass('tala_restaurants_v2.branches') IS NULL THEN
   RAISE EXCEPTION 'RESTAURANTS_001_REQUIRED';
 END IF;
END $guard$;

CREATE TABLE tala_restaurants_v2.branch_schedule_slots (
 branch_id uuid NOT NULL REFERENCES tala_restaurants_v2.branches(id) ON DELETE CASCADE,
 weekday smallint NOT NULL CHECK(weekday BETWEEN 0 AND 6),
 slot smallint NOT NULL CHECK(slot BETWEEN 0 AND 3),
 open_minute integer NOT NULL CHECK(open_minute BETWEEN 0 AND 1439),
 -- > 1440 means closing on the following local day.
 close_minute integer NOT NULL CHECK(close_minute BETWEEN 1 AND 2880),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,weekday,slot),
 CHECK(close_minute > open_minute AND close_minute - open_minute <= 1440)
);
CREATE INDEX ix_m6_schedule_branch_day
 ON tala_restaurants_v2.branch_schedule_slots(branch_id,weekday);

-- Existing single-slot hours remain authoritative in historical LAB data
-- until this migration copies them. New reads use the slots table exclusively.
INSERT INTO tala_restaurants_v2.branch_schedule_slots
 (branch_id,weekday,slot,open_minute,close_minute)
SELECT branch_id,weekday,0,open_minute,close_minute
FROM tala_restaurants_v2.hours WHERE NOT closed;

-- The compatibility "hours" table is retained for older admin consumers;
-- it is conservative (closed) when a new schedule has multiple/night slots.
CREATE OR REPLACE FUNCTION tala_restaurants_v2.is_branch_scheduled_open(
 p_branch uuid,p_at timestamptz
) RETURNS boolean LANGUAGE sql STABLE AS $fn$
 SELECT EXISTS(
   SELECT 1 FROM tala_restaurants_v2.branch_schedule_slots s
   CROSS JOIN LATERAL (
     SELECT extract(dow from (p_at AT TIME ZONE 'America/Mexico_City'))::int AS dow,
       (extract(hour from (p_at AT TIME ZONE 'America/Mexico_City'))::int*60
        +extract(minute from (p_at AT TIME ZONE 'America/Mexico_City'))::int)
       AS minute
   ) AS local_time
   WHERE s.branch_id=p_branch AND (
      (s.weekday=local_time.dow
       AND local_time.minute>=s.open_minute
       AND local_time.minute<s.close_minute)
      OR (s.weekday=(local_time.dow+6)%7
       AND s.close_minute>1440
       AND local_time.minute<s.close_minute-1440)
   )
 );
$fn$;

ALTER TABLE tala_restaurants_v2.branches
 ADD COLUMN prep_minutes smallint NOT NULL DEFAULT 25
   CHECK(prep_minutes BETWEEN 5 AND 240),
 ADD COLUMN parallel_prep_slots smallint NOT NULL DEFAULT 5
   CHECK(parallel_prep_slots BETWEEN 1 AND 100);
COMMIT;
