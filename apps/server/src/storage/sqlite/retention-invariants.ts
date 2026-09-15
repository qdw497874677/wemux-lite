/** Retain identities and Session provenance for the lifetime of this database.
 * Soft deletion may remove history, never identity. No physical purge API is
 * currently supported; a future retention purge requires a separate migration
 * and whole-record policy, not disabling these guards in normal transactions.
 */
// A generic row must not acquire a retained Session identity via UPDATE, even
// when REPLACE would silently delete the destination without DELETE triggers.
export const retentionDestinationInvariants = `
CREATE TRIGGER session_record_destination BEFORE UPDATE ON records
WHEN NEW.kind='session' AND (OLD.kind IS NOT NEW.kind OR OLD.id IS NOT NEW.id)
BEGIN SELECT RAISE(ABORT, 'Session identity and provenance are retained'); END;
`

export const retentionInvariants = `
CREATE TRIGGER cancel_request_retention BEFORE DELETE ON run_cancel_requests
BEGIN SELECT RAISE(ABORT, 'Cancel request identity is retained'); END;
CREATE TRIGGER session_record_retention BEFORE DELETE ON records WHEN OLD.kind='session'
BEGIN SELECT RAISE(ABORT, 'Session identity and provenance are retained'); END;
CREATE TRIGGER session_record_identity BEFORE UPDATE ON records
WHEN OLD.kind='session' AND (NEW.kind IS NOT OLD.kind OR NEW.id IS NOT OLD.id)
BEGIN SELECT RAISE(ABORT, 'Session identity and provenance are retained'); END;
CREATE TRIGGER session_tombstone_update BEFORE UPDATE ON records
WHEN OLD.kind='session' AND json_extract(OLD.data,'$.deletedAt') IS NOT NULL
 AND json_extract(NEW.data,'$.deletedAt') IS NOT json_extract(OLD.data,'$.deletedAt')
BEGIN SELECT RAISE(ABORT, 'Session tombstone is immutable'); END;
CREATE TRIGGER session_tombstone_insert BEFORE INSERT ON records
WHEN NEW.kind='session' AND EXISTS (SELECT 1 FROM records old WHERE old.kind='session' AND old.id=NEW.id
 AND json_extract(old.data,'$.deletedAt') IS NOT NULL
 AND json_extract(NEW.data,'$.deletedAt') IS NOT json_extract(old.data,'$.deletedAt'))
BEGIN SELECT RAISE(ABORT, 'Session tombstone is immutable'); END;
CREATE TRIGGER deleted_session_event_insert BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM records WHERE kind='session' AND id=NEW.session_id AND json_extract(data,'$.deletedAt') IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Session deleted'); END;
CREATE TRIGGER deleted_session_event_update BEFORE UPDATE ON events
WHEN EXISTS (SELECT 1 FROM records WHERE kind='session' AND id=NEW.session_id AND json_extract(data,'$.deletedAt') IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'Session deleted'); END;
-- Historical cache is disposable; backfill removes any pre-upgrade late events.
DELETE FROM events WHERE session_id IN (SELECT id FROM records WHERE kind='session' AND json_extract(data,'$.deletedAt') IS NOT NULL);
`
