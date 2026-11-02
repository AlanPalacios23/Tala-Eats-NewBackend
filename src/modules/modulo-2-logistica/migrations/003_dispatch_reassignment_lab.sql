-- Module 2 only. Extend append-only event/outbox taxonomy for safe rerouting.
BEGIN;
ALTER TABLE tala_logistics_v2.dispatch_events
 DROP CONSTRAINT dispatch_events_event_type_check;
ALTER TABLE tala_logistics_v2.dispatch_events
 ADD CONSTRAINT dispatch_events_event_type_check
 CHECK (event_type IN ('dispatch.reserved','dispatch.completed','dispatch.released','dispatch.reassigned'));
ALTER TABLE tala_logistics_v2.outbox
 DROP CONSTRAINT outbox_event_type_check;
ALTER TABLE tala_logistics_v2.outbox
 ADD CONSTRAINT outbox_event_type_check
 CHECK (event_type IN ('dispatch.reserved','dispatch.completed','dispatch.released','dispatch.reassigned'));
COMMIT;
