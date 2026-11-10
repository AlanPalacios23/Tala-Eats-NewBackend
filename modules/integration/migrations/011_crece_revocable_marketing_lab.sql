-- M11 Crece LAB: revocable optional marketing consent, append-only by design.
-- Acceptance of founder terms remains immutable; marketing preference can be
-- withdrawn independently, without rewriting original consent evidence.
BEGIN;
DO $gate$
BEGIN
 IF current_database() NOT IN ('tala_integration_v2_test','tala_integration_v2_lab') THEN
  RAISE EXCEPTION 'M11_CRECE_LAB_ONLY';
 END IF;
 IF to_regclass('tala_integration_v2.crece_founder_consents') IS NULL THEN
  RAISE EXCEPTION 'M11_CRECE_009_REQUIRED';
 END IF;
END $gate$;

CREATE TABLE tala_integration_v2.crece_founder_marketing_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 application_id uuid NOT NULL
  REFERENCES tala_integration_v2.crece_founder_interest(application_id),
 operation_id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL,
 opted_in boolean NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_crece_marketing_events_application_latest
 ON tala_integration_v2.crece_founder_marketing_events(application_id,id DESC);
CREATE TRIGGER trg_crece_marketing_events_immutable
 BEFORE UPDATE OR DELETE
 ON tala_integration_v2.crece_founder_marketing_events
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();

-- Existing signed consent remains the initial opt-in state. Any newer
-- change is represented solely by a new immutable event; no mutable
-- preference cache that could disagree with the audit trail.
COMMIT;
