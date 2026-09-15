// Tombstones live for the database lifetime. Payload cleanup is allowed; identity
// cleanup is not. Generic document keys and JSON session references both matter.
export const retentionDestinationInvariants = `
CREATE TRIGGER tombstone_destination BEFORE UPDATE ON documents
WHEN NEW.bucket='deleted-sessions' AND (OLD.bucket IS NOT NEW.bucket OR OLD.id IS NOT NEW.id)
BEGIN SELECT RAISE(ABORT, 'Worker tombstone is immutable'); END;
`

export const retentionInvariants = `
CREATE TRIGGER tombstone_delete BEFORE DELETE ON documents WHEN OLD.bucket='deleted-sessions'
BEGIN SELECT RAISE(ABORT, 'Worker tombstone is retained'); END;
CREATE TRIGGER tombstone_update BEFORE UPDATE ON documents
WHEN OLD.bucket='deleted-sessions' AND (NEW.bucket IS NOT OLD.bucket OR NEW.id IS NOT OLD.id OR NEW.body IS NOT OLD.body)
BEGIN SELECT RAISE(ABORT, 'Worker tombstone is immutable'); END;
CREATE TRIGGER tombstone_replace BEFORE INSERT ON documents
WHEN NEW.bucket='deleted-sessions' AND EXISTS(SELECT 1 FROM documents WHERE bucket=NEW.bucket AND id=NEW.id AND body IS NOT NEW.body)
BEGIN SELECT RAISE(ABORT, 'Worker tombstone is immutable'); END;
${['INSERT', 'UPDATE'].map(operation => `
CREATE TRIGGER deleted_document_${operation.toLowerCase()} BEFORE ${operation} ON documents
WHEN NEW.bucket IN ('sessions','queue','turns') AND EXISTS (
 SELECT 1 FROM documents WHERE bucket='deleted-sessions' AND
 (id=json_extract(NEW.body,'$.sessionId') OR (NEW.bucket='sessions' AND id=NEW.id)))
BEGIN SELECT RAISE(ABORT, 'Session deleted'); END;
CREATE TRIGGER deleted_journal_${operation.toLowerCase()} BEFORE ${operation} ON journal
WHEN EXISTS (SELECT 1 FROM documents WHERE bucket='deleted-sessions' AND id=NEW.session_id)
BEGIN SELECT RAISE(ABORT, 'Session deleted'); END;
`).join('')}
DELETE FROM journal WHERE session_id IN (SELECT id FROM documents WHERE bucket='deleted-sessions');
DELETE FROM documents WHERE bucket IN ('sessions','queue','turns') AND (
 json_extract(body,'$.sessionId') IN (SELECT id FROM documents WHERE bucket='deleted-sessions')
 OR (bucket='sessions' AND id IN (SELECT id FROM documents WHERE bucket='deleted-sessions')));
`
