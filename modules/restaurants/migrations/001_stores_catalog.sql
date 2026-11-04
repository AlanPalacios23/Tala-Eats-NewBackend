-- M6 Restaurants & Local Commerce LAB, independent PostgreSQL schema.
-- Migrations are restricted to disposable databases and never touch LIVE.
BEGIN;
DO $guard$
BEGIN
  IF current_database() NOT IN ('tala_restaurants_v2_test','tala_restaurants_v2_lab') THEN
    RAISE EXCEPTION 'RESTAURANTS_LAB_ONLY';
  END IF;
END $guard$;
CREATE SCHEMA tala_restaurants_v2;

CREATE TABLE tala_restaurants_v2.stores (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL,
 slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(slug)<=60),
 display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 100),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=1000),
 kind text NOT NULL CHECK (kind IN
 ('restaurant','grocery','butcher','greengrocer','stationery','hardware','florist','other')),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','paused')),
 time_zone text NOT NULL DEFAULT 'America/Mexico_City'
   CHECK(time_zone='America/Mexico_City'),
 version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_m6_stores_owner ON tala_restaurants_v2.stores(owner_id,created_at DESC);

CREATE TABLE tala_restaurants_v2.store_staff (
 store_id uuid NOT NULL REFERENCES tala_restaurants_v2.stores(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','manager','editor')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(store_id,actor_id)
);
CREATE UNIQUE INDEX uq_m6_owner_per_store ON tala_restaurants_v2.store_staff(store_id)
 WHERE role='owner';

CREATE TABLE tala_restaurants_v2.branches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_id uuid NOT NULL REFERENCES tala_restaurants_v2.stores(id) ON DELETE RESTRICT,
 branch_name text NOT NULL CHECK(length(btrim(branch_name)) BETWEEN 2 AND 100),
 address_text text NOT NULL CHECK(length(btrim(address_text)) BETWEEN 5 AND 255),
 city text NOT NULL CHECK(city IN
 ('tala','ameca','ahualulco','tequila','cuisillos','amatitan')),
 latitude numeric(9,6),
 longitude numeric(9,6),
 pickup_enabled boolean NOT NULL DEFAULT true,
 delivery_enabled boolean NOT NULL DEFAULT false,
 is_active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT ck_m6_geo CHECK((latitude IS NULL AND longitude IS NULL)
   OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)),
 CONSTRAINT ck_m6_fulfillment CHECK (pickup_enabled OR delivery_enabled),
 UNIQUE(id,store_id)
);
CREATE INDEX ix_m6_branches_by_store ON tala_restaurants_v2.branches(store_id,created_at);

CREATE TABLE tala_restaurants_v2.hours (
 branch_id uuid NOT NULL REFERENCES tala_restaurants_v2.branches(id) ON DELETE CASCADE,
 weekday smallint NOT NULL CHECK(weekday BETWEEN 0 AND 6),
 open_minute integer,
 close_minute integer,
 closed boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(branch_id,weekday),
 CONSTRAINT ck_m6_hours CHECK (
  (closed AND open_minute IS NULL AND close_minute IS NULL)
  OR (NOT closed AND open_minute BETWEEN 0 AND 1439
      AND close_minute BETWEEN 1 AND 1440 AND open_minute<close_minute))
);

CREATE TABLE tala_restaurants_v2.products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_id uuid NOT NULL REFERENCES tala_restaurants_v2.stores(id) ON DELETE RESTRICT,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 120),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=1000),
 category text NOT NULL CHECK(length(btrim(category)) BETWEEN 2 AND 60),
 is_active boolean NOT NULL DEFAULT true,
 archived_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,store_id)
);
CREATE INDEX ix_m6_products_store ON tala_restaurants_v2.products(store_id,is_active,created_at DESC);

CREATE TABLE tala_restaurants_v2.variants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_id uuid NOT NULL,
 product_id uuid NOT NULL,
 label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 80),
 weight_grams integer CHECK(weight_grams IS NULL OR weight_grams BETWEEN 1 AND 1000000),
 price_cents bigint NOT NULL CHECK(price_cents BETWEEN 1 AND 100000000),
 stock_quantity integer NOT NULL DEFAULT 0 CHECK(stock_quantity BETWEEN 0 AND 1000000),
 track_stock boolean NOT NULL DEFAULT true,
 is_active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(product_id,store_id) REFERENCES tala_restaurants_v2.products(id,store_id)
  ON DELETE RESTRICT,
 UNIQUE(product_id,label),
 UNIQUE(id,store_id)
);
CREATE INDEX ix_m6_variants_store ON tala_restaurants_v2.variants(store_id,product_id,is_active);

CREATE TABLE tala_restaurants_v2.stock_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_id uuid NOT NULL,
 variant_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 delta integer NOT NULL CHECK(delta BETWEEN -1000000 AND 1000000 AND delta<>0),
 quantity_before integer NOT NULL CHECK(quantity_before BETWEEN 0 AND 1000000),
 quantity_after integer NOT NULL CHECK(quantity_after BETWEEN 0 AND 1000000),
 reason text NOT NULL CHECK(reason IN ('restock','correction','waste')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(variant_id,store_id) REFERENCES tala_restaurants_v2.variants(id,store_id),
 UNIQUE(store_id,operation_id)
);
CREATE INDEX ix_m6_stock_history ON tala_restaurants_v2.stock_adjustments(variant_id,created_at DESC);

CREATE TABLE tala_restaurants_v2.product_photos (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_id uuid NOT NULL,
 product_id uuid NOT NULL,
 object_key text NOT NULL CHECK(length(object_key) BETWEEN 16 AND 250
   AND object_key ~ '^m6/[a-z0-9/_-]+\.(webp|jpeg|png)$'),
 content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
 content_type text NOT NULL CHECK(content_type IN ('image/webp','image/jpeg','image/png')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','rejected')),
 is_primary boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(product_id,store_id) REFERENCES tala_restaurants_v2.products(id,store_id),
 CONSTRAINT ck_m6_primary_ready CHECK(NOT is_primary OR status='ready'),
 UNIQUE(object_key)
);
CREATE UNIQUE INDEX uq_m6_primary_photo ON tala_restaurants_v2.product_photos(product_id)
 WHERE is_primary;
CREATE INDEX ix_m6_photos_product ON tala_restaurants_v2.product_photos(product_id,status);

-- Generic idempotency receipts ensure creation is safe across retries.
CREATE TABLE tala_restaurants_v2.idempotency_receipts (
 actor_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 action text NOT NULL CHECK(length(action) BETWEEN 3 AND 80),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 result_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,operation_id)
);

CREATE TABLE tala_restaurants_v2.audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 store_id uuid NOT NULL REFERENCES tala_restaurants_v2.stores(id),
 actor_id uuid NOT NULL,
 action text NOT NULL CHECK(length(action) BETWEEN 3 AND 80),
 entity_id uuid NOT NULL,
 happened_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION tala_restaurants_v2.prevent_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
 RAISE EXCEPTION 'RESTAURANTS_AUDIT_IMMUTABLE' USING ERRCODE='23514';
END $fn$;
CREATE TRIGGER trg_m6_immutable_audit BEFORE UPDATE OR DELETE
ON tala_restaurants_v2.audit FOR EACH ROW
EXECUTE FUNCTION tala_restaurants_v2.prevent_audit_mutation();

COMMIT;
