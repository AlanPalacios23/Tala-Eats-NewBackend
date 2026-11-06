-- M6 LAB3: exceptional closure windows for individual branches.
-- No imports from dispatch, orders, users or notification modules.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_restaurants_v2_lab','tala_restaurants_v2_test') THEN
   RAISE EXCEPTION 'RESTAURANTS_LAB_ONLY';
 END IF;
 IF to_regclass('tala_restaurants_v2.branches') IS NULL THEN
   RAISE EXCEPTION 'RESTAURANTS_001_REQUIRED';
 END IF;
END $guard$;
CREATE TABLE tala_restaurants_v2.branch_closures (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_id uuid NOT NULL,
 branch_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 reason text NOT NULL CHECK(reason IN ('holiday','maintenance','emergency','other')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 cancelled_at timestamptz,
 cancelled_by uuid,
 FOREIGN KEY(branch_id,store_id) REFERENCES tala_restaurants_v2.branches(id,store_id),
 CHECK(ends_at > starts_at AND ends_at <= starts_at+interval '31 days'),
 CHECK((cancelled_at IS NULL AND cancelled_by IS NULL)
    OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
);
CREATE INDEX ix_m6_active_closures ON tala_restaurants_v2.branch_closures
 (branch_id,starts_at,ends_at) WHERE cancelled_at IS NULL;
CREATE INDEX ix_m6_closures_store ON tala_restaurants_v2.branch_closures
 (store_id,created_at DESC,id DESC);
COMMIT;
