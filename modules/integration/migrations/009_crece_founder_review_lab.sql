-- M11 Crece LAB9: real consent ledger and founder review with atomic 10-seat cap.
-- The original 008 selected_for_founders remains FALSE: do not rewrite history.
BEGIN;
DO $gate$
BEGIN
 IF current_database() NOT IN ('tala_integration_v2_test','tala_integration_v2_lab') THEN
  RAISE EXCEPTION 'M11_CRECE_LAB_ONLY';
 END IF;
 IF to_regclass('tala_integration_v2.crece_founder_interest') IS NULL THEN
  RAISE EXCEPTION 'M11_CRECE_008_REQUIRED';
 END IF;
END $gate$;
ALTER TABLE tala_integration_v2.crece_founder_interest
 ADD COLUMN agreement_version text
  CHECK (agreement_version IS NULL OR
   agreement_version='crece-founder-pilot-2026-11-v1'),
 ADD COLUMN agreement_accepted_at timestamptz,
 ADD COLUMN marketing_opt_in boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT ck_crece_consent_pair CHECK
  ((agreement_version IS NULL)=(agreement_accepted_at IS NULL));

-- No consent is ever backfilled for old applications.
CREATE TABLE tala_integration_v2.crece_founder_consents (
 application_id uuid PRIMARY KEY
  REFERENCES tala_integration_v2.crece_founder_interest(application_id),
 agreement_version text NOT NULL
  CHECK(agreement_version='crece-founder-pilot-2026-11-v1'),
 marketing_opt_in boolean NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER trg_crece_consents_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.crece_founder_consents
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();

CREATE TABLE tala_integration_v2.crece_founder_quota (
 program_id text PRIMARY KEY
  CHECK(program_id='crece-founder-pilot-2026-11-v1'),
 capacity smallint NOT NULL DEFAULT 10 CHECK(capacity=10),
 approved_count smallint NOT NULL DEFAULT 0 CHECK(approved_count BETWEEN 0 AND 10)
);
INSERT INTO tala_integration_v2.crece_founder_quota(program_id)
 VALUES('crece-founder-pilot-2026-11-v1');

CREATE TABLE tala_integration_v2.crece_founder_reviews (
 application_id uuid PRIMARY KEY
  REFERENCES tala_integration_v2.crece_founder_interest(application_id),
 operation_id uuid NOT NULL UNIQUE,
 reviewer_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approved','declined')),
 reason_code text CHECK(reason_code IN
  ('information_incomplete','not_eligible','pilot_full','owner_request','other')),
 reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (decision='approved' OR reason_code IS NOT NULL)
);

CREATE FUNCTION tala_integration_v2.enforce_founder_review_quota()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE updated_count integer;
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM tala_integration_v2.crece_founder_interest i
   JOIN tala_integration_v2.crece_founder_consents c
    ON c.application_id=i.application_id
  WHERE i.application_id=NEW.application_id AND
   i.agreement_version='crece-founder-pilot-2026-11-v1'
 ) THEN
  RAISE EXCEPTION 'CRECE_TERMS_REQUIRED' USING ERRCODE='23514';
 END IF;
 IF NEW.decision='approved' THEN
  UPDATE tala_integration_v2.crece_founder_quota
   SET approved_count=approved_count+1
   WHERE program_id='crece-founder-pilot-2026-11-v1'
     AND approved_count<capacity
   RETURNING approved_count INTO updated_count;
  IF updated_count IS NULL THEN
   RAISE EXCEPTION 'CRECE_FOUNDER_CAPACITY_FULL' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER trg_crece_review_quota
 BEFORE INSERT ON tala_integration_v2.crece_founder_reviews
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.enforce_founder_review_quota();
CREATE TRIGGER trg_crece_reviews_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.crece_founder_reviews
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();

CREATE TABLE tala_integration_v2.crece_founder_review_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 application_id uuid NOT NULL
  REFERENCES tala_integration_v2.crece_founder_reviews(application_id),
 decision text NOT NULL CHECK(decision IN ('approved','declined')),
 reviewer_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(application_id,decision)
);
CREATE TRIGGER trg_crece_review_events_immutable
 BEFORE UPDATE OR DELETE ON tala_integration_v2.crece_founder_review_events
 FOR EACH ROW EXECUTE FUNCTION tala_integration_v2.no_event_change();
COMMIT;
