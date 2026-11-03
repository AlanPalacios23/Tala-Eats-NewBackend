-- M4 LAB5: identity role classification and private profile data, no other domains.
BEGIN;
DO $guard$
BEGIN
  IF current_database() NOT IN ('tala_users_v2_lab','tala_users_v2_test') THEN
    RAISE EXCEPTION 'USERS_LAB_ONLY';
  END IF;
  IF to_regclass('tala_users_v2.accounts') IS NULL OR
     to_regclass('tala_users_v2.sessions') IS NULL THEN
    RAISE EXCEPTION 'USERS_001_003_REQUIRED';
  END IF;
END $guard$;

-- A public registration gets CUSTOMER only. Privileged role assignment must
-- be done by a separately audited/trusted identity administrator, NEVER by
-- a user profile API. No self-escalation endpoint exists.
CREATE TABLE tala_users_v2.account_roles (
  account_id uuid PRIMARY KEY REFERENCES tala_users_v2.accounts(id),
  role text NOT NULL DEFAULT 'customer' CHECK
    (role IN ('customer','merchant','courier','staff','owner')),
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION tala_users_v2.create_customer_role()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO tala_users_v2.account_roles(account_id,role)
    VALUES(NEW.id,'customer');
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_m4_default_customer
  AFTER INSERT ON tala_users_v2.accounts
  FOR EACH ROW EXECUTE FUNCTION tala_users_v2.create_customer_role();
-- Existing LAB accounts from before this migration get the same default.
INSERT INTO tala_users_v2.account_roles(account_id,role)
SELECT id,'customer' FROM tala_users_v2.accounts
ON CONFLICT(account_id) DO NOTHING;

CREATE TABLE tala_users_v2.user_preferences (
  account_id uuid PRIMARY KEY REFERENCES tala_users_v2.accounts(id),
  locale text NOT NULL DEFAULT 'es-MX' CHECK(locale IN ('es-MX','en-US')),
  marketing_opt_in boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE tala_users_v2.saved_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES tala_users_v2.accounts(id),
  label text NOT NULL CHECK(length(label) BETWEEN 2 AND 40
    AND label !~ '[[:cntrl:]<>]'),
  street text NOT NULL CHECK(length(street) BETWEEN 4 AND 140
    AND street !~ '[[:cntrl:]<>]'),
  exterior text NOT NULL CHECK(length(exterior) BETWEEN 1 AND 15
    AND exterior !~ '[[:cntrl:]<>]'),
  interior text CHECK(interior IS NULL OR
    (length(interior) BETWEEN 1 AND 20 AND interior !~ '[[:cntrl:]<>]')),
  neighborhood text NOT NULL CHECK(length(neighborhood) BETWEEN 2 AND 80
    AND neighborhood !~ '[[:cntrl:]<>]'),
  city text NOT NULL CHECK(length(city) BETWEEN 2 AND 80
    AND city !~ '[[:cntrl:]<>]'),
  state text NOT NULL CHECK(length(state) BETWEEN 2 AND 80
    AND state !~ '[[:cntrl:]<>]'),
  postal_code text NOT NULL CHECK(postal_code ~ '^[0-9]{5}$'),
  country text NOT NULL DEFAULT 'MX' CHECK(country='MX'),
  is_default boolean NOT NULL DEFAULT false,
  creation_payload_hash text NOT NULL CHECK(creation_payload_hash ~ '^[a-f0-9]{64}(creation_event_key ~ '^[a-f0-9]{64} timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX uq_m4_address_create_replay ON
  tala_users_v2.saved_addresses(account_id,creation_event_key);
CREATE INDEX ix_m4_address_owner ON
  tala_users_v2.saved_addresses(account_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX uq_m4_address_default_per_account ON
  tala_users_v2.saved_addresses(account_id) WHERE is_default;

-- Identity/profile PII must not remain on account tombstones.
CREATE FUNCTION tala_users_v2.purge_private_profile_on_deletion()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status='deleted' AND OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM tala_users_v2.saved_addresses WHERE account_id=NEW.id;
    DELETE FROM tala_users_v2.user_preferences WHERE account_id=NEW.id;
    DELETE FROM tala_users_v2.account_roles WHERE account_id=NEW.id;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_m4_purge_profile_on_deletion
  AFTER UPDATE OF status ON tala_users_v2.accounts
  FOR EACH ROW EXECUTE FUNCTION tala_users_v2.purge_private_profile_on_deletion();
COMMIT;
),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_m4_address_owner ON
  tala_users_v2.saved_addresses(account_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX uq_m4_address_default_per_account ON
  tala_users_v2.saved_addresses(account_id) WHERE is_default;

-- Identity/profile PII must not remain on account tombstones.
CREATE FUNCTION tala_users_v2.purge_private_profile_on_deletion()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status='deleted' AND OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM tala_users_v2.saved_addresses WHERE account_id=NEW.id;
    DELETE FROM tala_users_v2.user_preferences WHERE account_id=NEW.id;
    DELETE FROM tala_users_v2.account_roles WHERE account_id=NEW.id;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_m4_purge_profile_on_deletion
  AFTER UPDATE OF status ON tala_users_v2.accounts
  FOR EACH ROW EXECUTE FUNCTION tala_users_v2.purge_private_profile_on_deletion();
COMMIT;
),
  creation_event_key text NOT NULL CHECK(creation_event_key ~ '^[a-f0-9]{64} timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX uq_m4_address_create_replay ON
  tala_users_v2.saved_addresses(account_id,creation_event_key);
CREATE INDEX ix_m4_address_owner ON
  tala_users_v2.saved_addresses(account_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX uq_m4_address_default_per_account ON
  tala_users_v2.saved_addresses(account_id) WHERE is_default;

-- Identity/profile PII must not remain on account tombstones.
CREATE FUNCTION tala_users_v2.purge_private_profile_on_deletion()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status='deleted' AND OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM tala_users_v2.saved_addresses WHERE account_id=NEW.id;
    DELETE FROM tala_users_v2.user_preferences WHERE account_id=NEW.id;
    DELETE FROM tala_users_v2.account_roles WHERE account_id=NEW.id;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_m4_purge_profile_on_deletion
  AFTER UPDATE OF status ON tala_users_v2.accounts
  FOR EACH ROW EXECUTE FUNCTION tala_users_v2.purge_private_profile_on_deletion();
COMMIT;
),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_m4_address_owner ON
  tala_users_v2.saved_addresses(account_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX uq_m4_address_default_per_account ON
  tala_users_v2.saved_addresses(account_id) WHERE is_default;

-- Identity/profile PII must not remain on account tombstones.
CREATE FUNCTION tala_users_v2.purge_private_profile_on_deletion()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.status='deleted' AND OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM tala_users_v2.saved_addresses WHERE account_id=NEW.id;
    DELETE FROM tala_users_v2.user_preferences WHERE account_id=NEW.id;
    DELETE FROM tala_users_v2.account_roles WHERE account_id=NEW.id;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_m4_purge_profile_on_deletion
  AFTER UPDATE OF status ON tala_users_v2.accounts
  FOR EACH ROW EXECUTE FUNCTION tala_users_v2.purge_private_profile_on_deletion();
COMMIT;
