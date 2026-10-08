/** Schema 6: permanent requestId dedupe, immutable results, and application ACK only. */
export const fileWriteInvariants = `
CREATE TABLE worker_file_admissions (
  request_id TEXT PRIMARY KEY NOT NULL,
  admission_json TEXT NOT NULL CHECK(json_valid(admission_json) AND json_extract(admission_json,'$.requestId') IS request_id)
);
CREATE TABLE worker_file_results (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES worker_file_admissions(request_id),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_extract(result_json,'$.requestId') IS request_id)
);
CREATE TABLE worker_file_result_delivery (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES worker_file_results(request_id),
  acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1))
);
CREATE TRIGGER worker_file_admission_no_replace BEFORE INSERT ON worker_file_admissions
WHEN EXISTS(SELECT 1 FROM worker_file_admissions WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'File admission is immutable'); END;
CREATE TRIGGER worker_file_admission_no_update BEFORE UPDATE ON worker_file_admissions
BEGIN SELECT RAISE(ABORT,'File admission is immutable'); END;
CREATE TRIGGER worker_file_admission_no_delete BEFORE DELETE ON worker_file_admissions
BEGIN SELECT RAISE(ABORT,'File admission is retained'); END;
CREATE TRIGGER worker_file_result_no_replace BEFORE INSERT ON worker_file_results
WHEN EXISTS(SELECT 1 FROM worker_file_results WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'File result is immutable'); END;
CREATE TRIGGER worker_file_result_requires_admission BEFORE INSERT ON worker_file_results
WHEN NOT EXISTS(SELECT 1 FROM worker_file_admissions WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'File admission not found'); END;
CREATE TRIGGER worker_file_result_no_update BEFORE UPDATE ON worker_file_results
BEGIN SELECT RAISE(ABORT,'File result is immutable'); END;
CREATE TRIGGER worker_file_result_no_delete BEFORE DELETE ON worker_file_results
BEGIN SELECT RAISE(ABORT,'File result is retained'); END;
CREATE TRIGGER worker_file_result_delivery_insert AFTER INSERT ON worker_file_results
BEGIN INSERT INTO worker_file_result_delivery(request_id,acknowledged) VALUES(NEW.request_id,0); END;
CREATE TRIGGER worker_file_delivery_no_replace BEFORE INSERT ON worker_file_result_delivery
WHEN EXISTS(SELECT 1 FROM worker_file_result_delivery WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'File result delivery is retained'); END;
CREATE TRIGGER worker_file_delivery_requires_result BEFORE INSERT ON worker_file_result_delivery
WHEN NEW.acknowledged != 0 OR NOT EXISTS(SELECT 1 FROM worker_file_results WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'File result delivery requires retained result'); END;
CREATE TRIGGER worker_file_delivery_ack_only BEFORE UPDATE ON worker_file_result_delivery
WHEN NEW.request_id IS NOT OLD.request_id OR NEW.acknowledged < OLD.acknowledged
BEGIN SELECT RAISE(ABORT,'File result delivery only permits acknowledgment'); END;
CREATE TRIGGER worker_file_delivery_no_delete BEFORE DELETE ON worker_file_result_delivery
BEGIN SELECT RAISE(ABORT,'File result delivery is retained'); END;
`
