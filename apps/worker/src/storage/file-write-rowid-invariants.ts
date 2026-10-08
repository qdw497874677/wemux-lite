/** Schema 7: rowid is also a replacement identity on ordinary SQLite tables. */
export const fileWriteRowidTables = ['worker_file_admissions', 'worker_file_results', 'worker_file_result_delivery'] as const

export const fileWriteRowidInvariants = fileWriteRowidTables.map(table => `
CREATE TRIGGER ${table}_rowid_no_replace BEFORE INSERT ON ${table}
WHEN EXISTS(SELECT 1 FROM ${table} WHERE rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'File storage rowid is immutable'); END;
-- BEFORE INSERT uses -1 for an unspecified rowid. Reserve that internal sentinel
-- after allocation, so ordinary automatic inserts remain valid.
CREATE TRIGGER ${table}_rowid_no_sentinel AFTER INSERT ON ${table}
WHEN NEW.rowid=-1
BEGIN SELECT RAISE(ABORT,'File storage rowid -1 is reserved'); END;
CREATE TRIGGER ${table}_rowid_no_update BEFORE UPDATE ON ${table}
WHEN NEW.rowid IS NOT OLD.rowid
BEGIN SELECT RAISE(ABORT,'File storage rowid is immutable'); END;
`).join('\n')
