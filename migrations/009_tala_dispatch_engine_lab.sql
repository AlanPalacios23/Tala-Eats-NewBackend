-- CORE v2 / TALА DISPATCH ENGINE: private offer queue, LAB ONLY.
-- AFTER 001-008. No shared/LIVE/Render migration.
BEGIN;
ALTER TABLE tala_core_v2.driver_profiles
  ADD COLUMN dispatch_heartbeat_at timestamptz,
  ADD COLUMN last_dispatch_offer_at timestamptz;
CREATE TABLE tala_core_v2.dispatch_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES tala_core_v2.orders(id),
  driver_id uuid NOT NULL REFERENCES tala_core_v2.driver_profiles(account_id),
  state text NOT NULL DEFAULT 'offered'
    CHECK (state IN ('offered','accepted','declined','expired')),
  expected_order_version bigint NOT NULL CHECK(expected_order_version>=1),
  accepted_order_version bigint CHECK(accepted_order_version>=2),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK (expires_at>created_at),
  CHECK ((state='offered' AND decided_at IS NULL AND accepted_order_version IS NULL)
    OR (state='accepted' AND decided_at IS NOT NULL AND accepted_order_version IS NOT NULL)
    OR (state IN ('declined','expired') AND decided_at IS NOT NULL AND accepted_order_version IS NULL))
);
-- One pending offer per order and per driver, enforced even under racing workers.
CREATE UNIQUE INDEX ux_dispatch_offer_order_pending
  ON tala_core_v2.dispatch_offers(order_id) WHERE state='offered';
CREATE UNIQUE INDEX ux_dispatch_offer_driver_pending
  ON tala_core_v2.dispatch_offers(driver_id) WHERE state='offered';
CREATE INDEX ix_dispatch_history_order ON tala_core_v2.dispatch_offers(order_id,created_at,id);
CREATE INDEX ix_dispatch_offer_expiry ON tala_core_v2.dispatch_offers(expires_at,id)
  WHERE state='offered';

-- A claimed/accepted order always has its order_driver_assignments truth.
-- No change to order, cash or PIN snapshots. Offers carry no address/GPS.
COMMIT;
