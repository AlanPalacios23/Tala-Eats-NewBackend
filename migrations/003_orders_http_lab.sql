-- CORE v2 isolated LAB ONLY. Apply after 001 and 002.
-- Never run against tala_node_live, tala_node_stage or a shared Stripe database.
BEGIN;
CREATE TABLE IF NOT EXISTS tala_core_v2.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (char_length(email) BETWEEN 5 AND 254 AND email=lower(email)),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 100),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('customer','merchant')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tala_core_v2.sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  account_id uuid NOT NULL REFERENCES tala_core_v2.accounts(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_core_sessions_account ON tala_core_v2.sessions(account_id);
CREATE TABLE IF NOT EXISTS tala_core_v2.restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 140),
  is_open boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tala_core_v2.catalog_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES tala_core_v2.restaurants(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 180),
  price_minor bigint NOT NULL CHECK (price_minor>0 AND price_minor<=1000000000),
  stock integer NOT NULL DEFAULT 0 CHECK (stock>=0),
  is_available boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_core_catalog_restaurant ON tala_core_v2.catalog_products(restaurant_id);
ALTER TABLE tala_core_v2.orders
  ADD COLUMN IF NOT EXISTS delivery_address text
    CHECK (delivery_address IS NULL OR char_length(delivery_address) BETWEEN 5 AND 240);
-- Intentional: migration 001 order ids are independent and existing schema tests
-- insert arbitrary UUIDs. Ownership is checked with explicit lookups and
-- membership inside each command; FK backfill comes after migration design.
COMMIT;
