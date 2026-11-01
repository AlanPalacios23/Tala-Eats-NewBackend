-- PIN generation is part of the Orders module, never a general auth service.
-- Apply AFTER 005 and ONLY to disposable, local CORE v2 LAB.
BEGIN;
ALTER TABLE tala_core_v2.order_handoffs
  ADD COLUMN IF NOT EXISTS pin_window_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS pin_generation_count integer NOT NULL DEFAULT 0
    CHECK(pin_generation_count BETWEEN 0 AND 6);
COMMIT;
