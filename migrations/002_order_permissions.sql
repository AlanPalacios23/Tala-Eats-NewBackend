-- CORE v2 Módulo 1. Only isolated PostgreSQL; never run on tala_node_live.
-- The authentication layer will provision memberships after verifying ownership.
-- This table is NOT proof of identity on its own and has no public write route.
BEGIN;
CREATE TABLE IF NOT EXISTS tala_core_v2.restaurant_memberships (
  restaurant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_core_restaurant_memberships_user
  ON tala_core_v2.restaurant_memberships (member_id, restaurant_id)
  WHERE is_active = true;
COMMIT;
