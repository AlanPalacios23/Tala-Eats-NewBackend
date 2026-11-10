-- RC6 M11: Tala Eats Crece / Fundadores internal interest queue, LAB ONLY.
-- No public enrollment endpoint, no automatic founder slots or fee changes.
BEGIN;
DO $guard$
BEGIN
 IF current_database() NOT IN ('tala_integration_v2_test','tala_integration_v2_lab') THEN
  RAISE EXCEPTION 'M11_CRECE_LAB_ONLY';
 END IF;
 IF to_regclass('tala_integration_v2.events') IS NULL THEN
  RAISE EXCEPTION 'M11_INBOX_REQUIRED';
 END IF;
END $guard$;
CREATE TABLE tala_integration_v2.crece_founder_interest (
 application_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 m6_store_id uuid NOT NULL UNIQUE,
 m6_staff_actor_id uuid NOT NULL,
 operation_id uuid NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'interested' CHECK(state='interested'),
 selected_for_founders boolean NOT NULL DEFAULT false
  CHECK(selected_for_founders=false),
 commission_bps integer NOT NULL DEFAULT 1700 CHECK(commission_bps=1700),
 monthly_fee_minor bigint NOT NULL DEFAULT 0 CHECK(monthly_fee_minor=0),
 policy_version text NOT NULL DEFAULT 'crece-founder-pilot-2026-11-v1'
  CHECK(policy_version='crece-founder-pilot-2026-11-v1'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE tala_integration_v2.crece_founder_interest_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 application_id uuid NOT NULL REFERENCES tala_integration_v2.crece_founder_interest(application_id),
 event_type text NOT NULL DEFAULT 'founders.interest_submitted'
  CHECK(event_type='founders.interest_submitted'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(application_id,event_type)
);
CREATE TRIGGER trg_crece_interest_events_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.crece_founder_interest_events
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();
COMMIT;
