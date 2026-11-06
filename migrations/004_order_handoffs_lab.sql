-- TALA EATS CORE v2: completion of cash order handoff in ISOLATED LAB only.
-- Apply ONLY after 001, 002, 003. Never touch production or shared databases.
BEGIN;
ALTER TABLE tala_core_v2.accounts
  DROP CONSTRAINT IF EXISTS accounts_role_check;
ALTER TABLE tala_core_v2.accounts
  ADD CONSTRAINT accounts_role_check
  CHECK (role IN ('customer','merchant','driver'));

CREATE TABLE IF NOT EXISTS tala_core_v2.driver_profiles (
  account_id uuid PRIMARY KEY REFERENCES tala_core_v2.accounts(id),
  approved boolean NOT NULL DEFAULT false,
  is_online boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tala_core_v2.order_driver_assignments (
  order_id uuid PRIMARY KEY REFERENCES tala_core_v2.orders(id),
  driver_id uuid NOT NULL REFERENCES tala_core_v2.accounts(id),
  assigned_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_core_driver_assignments_driver
  ON tala_core_v2.order_driver_assignments(driver_id,assigned_at DESC);

CREATE TABLE IF NOT EXISTS tala_core_v2.order_handoffs (
  order_id uuid PRIMARY KEY REFERENCES tala_core_v2.orders(id),
  pin_salt text,
  pin_hash text,
  pin_expires_at timestamptz,
  pin_failures integer NOT NULL DEFAULT 0 CHECK (pin_failures BETWEEN 0 AND 5),
  pin_consumed_at timestamptz,
  buyer_cash_ack_at timestamptz,
  custodian_cash_ack_at timestamptz,
  custodian_id uuid REFERENCES tala_core_v2.accounts(id),
  custodian_role text CHECK (custodian_role IN ('merchant','driver')),
  cash_amount_minor bigint NOT NULL CHECK (cash_amount_minor > 0),
  custody_settled_at timestamptz,
  CHECK (
    (pin_hash IS NULL AND pin_salt IS NULL AND pin_expires_at IS NULL)
    OR
    (pin_hash ~ '^[a-f0-9]{128}$'
      AND pin_salt ~ '^[a-f0-9]{32}$' AND pin_expires_at IS NOT NULL)
  ),
  CHECK ((custodian_cash_ack_at IS NULL AND custodian_id IS NULL
          AND custodian_role IS NULL)
    OR (custodian_cash_ack_at IS NOT NULL AND custodian_id IS NOT NULL
          AND custodian_role IS NOT NULL))
);
-- Important: cash paid at handoff does NOT imply custody has been settled
-- to a merchant, bank, Stripe, or platform wallet. Ledger comes later.
COMMIT;
