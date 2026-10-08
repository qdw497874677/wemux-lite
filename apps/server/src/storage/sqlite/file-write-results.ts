/** Append-only schema 34. Result bytes are separate from immutable held intents.
 * The application verifies hashes and canonical result JSON with the shared parser;
 * SQL protects retained identities/bytes even against REPLACE with recursion off.
 */
export const fileWriteResultsMigration = `
  CREATE TEMP TABLE file_result_rowid_preflight (
    count INTEGER CONSTRAINT "File storage migration refuses protected rowid -1" CHECK(count=0)
  );
  INSERT INTO file_result_rowid_preflight SELECT count(*) FROM records
    WHERE rowid=-1 AND kind IN ('file-write-admission','file-write-intent','file-write-result');
  DROP TABLE file_result_rowid_preflight;

  CREATE TRIGGER IF NOT EXISTS file_result_shape BEFORE INSERT ON records
  WHEN NEW.kind='file-write-result' AND (
    json_extract(NEW.data,'$.type') IS NOT 'fs.write.result'
    OR json_extract(NEW.data,'$.requestId') IS NOT NEW.id
    OR json_extract(NEW.data,'$.resultVersion') IS NOT 1
    OR json_extract(NEW.data,'$.outcome') NOT IN ('succeeded','rejected-before-effect','unknown')
    OR json_type(NEW.data,'$.outcome') IS NOT 'text'
    OR json_type(NEW.data,'$.resultJson') IS NOT 'text'
    OR json_type(NEW.data,'$.resultDigest') IS NOT 'text'
    OR length(json_extract(NEW.data,'$.resultDigest'))<>64
    OR NOT EXISTS (SELECT 1 FROM records WHERE kind='file-write-admission' AND id=NEW.id
      AND json_extract(data,'$.sessionId') IS json_extract(NEW.data,'$.sessionId')
      AND json_extract(data,'$.workerId') IS json_extract(NEW.data,'$.workerId')
      AND json_extract(data,'$.operation') IS json_extract(NEW.data,'$.operation')
      AND json_extract(data,'$.fingerprintVersion') IS json_extract(NEW.data,'$.fingerprintVersion')
      AND json_extract(data,'$.fingerprint') IS json_extract(NEW.data,'$.fingerprint'))
  ) BEGIN SELECT RAISE(ABORT,'Invalid file write result'); END;
  CREATE TRIGGER IF NOT EXISTS file_result_replace BEFORE INSERT ON records
  WHEN NEW.kind='file-write-result' AND EXISTS (
    SELECT 1 FROM records WHERE kind=NEW.kind AND id=NEW.id
  ) BEGIN SELECT RAISE(ABORT,'File write result is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS file_result_update BEFORE UPDATE ON records
  WHEN OLD.kind='file-write-result' OR NEW.kind='file-write-result'
  BEGIN SELECT RAISE(ABORT,'File write result is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS file_result_delete BEFORE DELETE ON records
  WHEN OLD.kind='file-write-result'
  BEGIN SELECT RAISE(ABORT,'File write result is immutable'); END;

  -- The destination kind need not be protected: a different kind can replace a
  -- protected row via the independent unique rowid with recursive_triggers OFF.
  CREATE TRIGGER IF NOT EXISTS file_result_rowid_replace BEFORE INSERT ON records
  WHEN EXISTS (SELECT 1 FROM records WHERE rowid=NEW.rowid
    AND kind IN ('file-write-admission','file-write-intent','file-write-result'))
  BEGIN SELECT RAISE(ABORT,'File storage rowid is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS file_result_rowid_update BEFORE UPDATE ON records
  WHEN EXISTS (SELECT 1 FROM records WHERE rowid=NEW.rowid
    AND kind IN ('file-write-admission','file-write-intent','file-write-result'))
  BEGIN SELECT RAISE(ABORT,'File storage rowid is immutable'); END;
  -- SQLite supplies -1 before automatic rowid allocation. Reject only after
  -- allocation; unrelated kinds may still persist -1 without blocking inserts.
  CREATE TRIGGER IF NOT EXISTS file_result_rowid_sentinel AFTER INSERT ON records
  WHEN NEW.rowid=-1 AND NEW.kind IN ('file-write-admission','file-write-intent','file-write-result')
  BEGIN SELECT RAISE(ABORT,'File storage rowid -1 is reserved'); END;
`
