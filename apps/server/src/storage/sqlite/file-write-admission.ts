/** Append-only application records, deliberately absent from command/transport delivery. */
export const fileWriteAdmissionMigration = `
  CREATE UNIQUE INDEX IF NOT EXISTS file_write_request_identity ON records(
    json_extract(data,'$.actorId'), json_extract(data,'$.sessionId'), json_extract(data,'$.requestId')
  ) WHERE kind='file-write-admission';
  CREATE TRIGGER IF NOT EXISTS file_write_admission_shape BEFORE INSERT ON records
  WHEN NEW.kind='file-write-admission' AND (
    json_extract(NEW.data,'$.admissionId') IS NOT NEW.id
    OR json_type(NEW.data,'$.actorId') IS NOT 'text' OR length(json_extract(NEW.data,'$.actorId'))=0
    OR json_type(NEW.data,'$.sessionId') IS NOT 'text' OR length(json_extract(NEW.data,'$.sessionId'))=0
    OR json_type(NEW.data,'$.requestId') IS NOT 'text' OR length(json_extract(NEW.data,'$.requestId'))=0
    OR json_extract(NEW.data,'$.operation') IS NOT 'fs.write'
    OR json_type(NEW.data,'$.workerId') IS NOT 'text'
    OR json_extract(NEW.data,'$.workerId') IS NOT json_extract(NEW.data,'$.binding.agent.workerId')
    OR json_type(NEW.data,'$.binding.workspaceId') IS NOT 'text'
    OR json_type(NEW.data,'$.binding.agent.agentKey') IS NOT 'text'
    OR json_type(NEW.data,'$.binding.modelId') NOT IN ('text','null')
    OR json_type(NEW.data,'$.binding.modelId') IS NULL
    OR json_type(NEW.data,'$.subpath') IS NOT 'text'
    OR json_type(NEW.data,'$.base64Content') IS NOT 'text'
    OR json_extract(NEW.data,'$.fingerprintVersion') IS NOT 1
    OR json_type(NEW.data,'$.fingerprint') IS NOT 'text' OR length(json_extract(NEW.data,'$.fingerprint'))<>64
    OR julianday(json_extract(NEW.data,'$.admittedAt')) IS NULL
  ) BEGIN SELECT RAISE(ABORT, 'Invalid file write admission'); END;
  CREATE TRIGGER IF NOT EXISTS file_write_intent_shape BEFORE INSERT ON records
  WHEN NEW.kind='file-write-intent' AND (
    json_extract(NEW.data,'$.admissionId') IS NOT NEW.id
    OR json_extract(NEW.data,'$.state') IS NOT 'held'
    OR NOT EXISTS (SELECT 1 FROM records WHERE kind='file-write-admission' AND id=NEW.id)
  ) BEGIN SELECT RAISE(ABORT, 'Invalid held file write intent'); END;
  CREATE TRIGGER IF NOT EXISTS file_write_hold AFTER INSERT ON records
  WHEN NEW.kind='file-write-admission'
  BEGIN INSERT INTO records(kind,id,data) VALUES('file-write-intent',NEW.id,json_object('admissionId',NEW.id,'state','held')); END;
  CREATE TRIGGER IF NOT EXISTS file_write_immutable_update BEFORE UPDATE ON records
  WHEN OLD.kind IN ('file-write-admission','file-write-intent') OR NEW.kind IN ('file-write-admission','file-write-intent')
  BEGIN SELECT RAISE(ABORT, 'File write admission and held intent are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS file_write_immutable_delete BEFORE DELETE ON records
  WHEN OLD.kind IN ('file-write-admission','file-write-intent')
  BEGIN SELECT RAISE(ABORT, 'File write admission and held intent are immutable'); END;
`

/** Corrective migration for already-recorded stage 1 schemas. REPLACE's implicit
 * deletes skip delete triggers when recursive_triggers is off; guard before insert.
 */
export const fileWriteReplacementMigration = `
  CREATE TRIGGER IF NOT EXISTS file_write_admission_replace BEFORE INSERT ON records
  WHEN NEW.kind='file-write-admission' AND EXISTS (
    SELECT 1 FROM records WHERE kind=NEW.kind AND (
      id=NEW.id OR (
        json_extract(data,'$.actorId')=json_extract(NEW.data,'$.actorId')
        AND json_extract(data,'$.sessionId')=json_extract(NEW.data,'$.sessionId')
        AND json_extract(data,'$.requestId')=json_extract(NEW.data,'$.requestId')
      )
    )
  ) BEGIN SELECT RAISE(ABORT, 'File write admission identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS file_write_intent_replace BEFORE INSERT ON records
  WHEN NEW.kind='file-write-intent' AND EXISTS (
    SELECT 1 FROM records WHERE kind=NEW.kind AND id=NEW.id
  ) BEGIN SELECT RAISE(ABORT, 'Held file write intent is immutable'); END;
`
