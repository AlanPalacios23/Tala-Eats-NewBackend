-- M11 Crece: 7 human-assisted benefits, auditable LAB-only service requests.
-- Never represents automatic marketing credits, delivered photography, payouts,
-- reservations or release of any customer-facing capability.
BEGIN;
DO $lab$
BEGIN
 IF current_database() NOT IN ('tala_integration_v2_test','tala_integration_v2_lab') THEN
  RAISE EXCEPTION 'M11_CRECE_LAB_ONLY';
 END IF;
 IF to_regclass('tala_integration_v2.crece_founder_interest') IS NULL THEN
  RAISE EXCEPTION 'M11_CRECE_FOUNDERS_REQUIRED';
 END IF;
END $lab$;
CREATE TABLE tala_integration_v2.crece_assisted_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 store_id uuid NOT NULL,
 requested_by uuid NOT NULL,
 benefit_id text NOT NULL CHECK(benefit_id IN
  ('alta','fotos','kit','destacado','redes','comisiones','soporte')),
 UNIQUE(store_id,benefit_id),
 operation_id uuid NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX crece_assisted_requests_store ON
 tala_integration_v2.crece_assisted_requests(store_id,created_at DESC);
CREATE TABLE tala_integration_v2.crece_assisted_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES
  tala_integration_v2.crece_assisted_requests(id),
 operation_id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN
  ('requested','in_progress','reported_completed','declined')),
 note text NOT NULL DEFAULT '' CHECK(length(note)<=500),
 evidence_sha256 text CHECK(evidence_sha256 IS NULL OR
  evidence_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(status<>'reported_completed' OR evidence_sha256 IS NOT NULL)
);
CREATE INDEX crece_assisted_events_latest ON
 tala_integration_v2.crece_assisted_events(request_id,id DESC);
CREATE TRIGGER trg_crece_assisted_requests_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.crece_assisted_requests
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();
CREATE TRIGGER trg_crece_assisted_events_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.crece_assisted_events
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();
COMMIT;
