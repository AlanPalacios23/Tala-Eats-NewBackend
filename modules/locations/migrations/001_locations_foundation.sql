-- TALA EATS CORE v2 / M7: Locations LAB1. Database completely isolated.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_locations_v2_test','tala_locations_v2_lab') THEN
   RAISE EXCEPTION 'LOCATIONS_LAB_ONLY';
 END IF;
END $guard$;
CREATE SCHEMA tala_locations_v2;

-- Configured by a trusted operator; never infer geographic coverage from city names.
CREATE TABLE tala_locations_v2.coverage_zones (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug)<=60),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 100),
 city text NOT NULL CHECK(city IN
 ('tala','ameca','ahualulco','tequila','cuisillos','amatitan')),
 center_lat numeric(9,6) NOT NULL CHECK(center_lat BETWEEN -90 AND 90),
 center_lon numeric(9,6) NOT NULL CHECK(center_lon BETWEEN -180 AND 180),
 radius_m integer NOT NULL CHECK(radius_m BETWEEN 100 AND 50000),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','disabled')),
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_m7_zone_active_city ON tala_locations_v2.coverage_zones(city,status);

-- Saved personal points are encrypted at application layer: no plaintext
-- address text, coordinates, labels, reference or postal code in this table.
CREATE TABLE tala_locations_v2.saved_places (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL,
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 4096),
 nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
 auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
 is_default boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
 deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX uq_m7_one_default_place ON tala_locations_v2.saved_places(owner_id)
 WHERE is_default AND deleted_at IS NULL;
CREATE INDEX ix_m7_places_owner ON tala_locations_v2.saved_places(owner_id,created_at DESC)
 WHERE deleted_at IS NULL;

-- Short-lived, encrypted, per-actor location snapshot. Not a tracking history.
CREATE TABLE tala_locations_v2.location_snapshots (
 owner_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('foreground','active_delivery')),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 2048),
 nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
 auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(owner_id,purpose),
 CHECK(expires_at>updated_at)
);
CREATE INDEX ix_m7_snapshot_expiry ON tala_locations_v2.location_snapshots(expires_at);

CREATE TABLE tala_locations_v2.idempotency_receipts (
 actor_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 action text NOT NULL CHECK(length(action) BETWEEN 3 AND 80),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 result_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,operation_id)
);

-- Audit never includes location, street, ciphertext or raw request content.
CREATE TABLE tala_locations_v2.audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK(length(action) BETWEEN 3 AND 80),
 entity_id uuid NOT NULL,
 happened_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION tala_locations_v2.prevent_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
 RAISE EXCEPTION 'LOCATIONS_AUDIT_IMMUTABLE' USING ERRCODE='23514';
END $fn$;
CREATE TRIGGER trg_m7_audit_immutable BEFORE UPDATE OR DELETE
 ON tala_locations_v2.audit FOR EACH ROW
 EXECUTE FUNCTION tala_locations_v2.prevent_audit_mutation();
COMMIT;
