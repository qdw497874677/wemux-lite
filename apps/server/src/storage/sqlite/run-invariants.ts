// Keep JSON as the public representation. Views give migration preflight and write
// triggers exactly the same predicates; reverse triggers protect referenced rows.
export const identity = (value: string) => `typeof(${value})='text' AND instr(${value},char(0))=0
  AND length(trim(${value}, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0
  AND length(${value})<=200
  AND (WITH RECURSIVE units(i,n) AS (SELECT 1,0 UNION ALL SELECT i+1,n+CASE WHEN unicode(substr(${value},i,1))>65535 THEN 2 ELSE 1 END FROM units WHERE i<=min(length(${value}),201)) SELECT max(n) FROM units)<=200`
const binding = (session: string, run: string) => `json_extract(${session},'$.binding.workspaceId') IS json_extract(${run},'$.snapshot.workspaceId')
  AND json_extract(${session},'$.binding.agent.workerId') IS json_extract(${run},'$.snapshot.workerId')
  AND json_extract(${session},'$.binding.agent.agentKey') IS json_extract(${run},'$.snapshot.agentKey')
  AND json_extract(${session},'$.binding.modelId') IS json_extract(${run},'$.snapshot.modelId')`

export const runInvariants = `
ALTER TABLE records ADD COLUMN source_run_id TEXT GENERATED ALWAYS AS
  (CASE WHEN kind='session' THEN json_extract(data,'$.runId') END) VIRTUAL
  REFERENCES task_runs(id) DEFERRABLE INITIALLY DEFERRED;
CREATE VIEW invalid_cancel_requests AS SELECT c.rowid AS row_id FROM run_cancel_requests c
 WHERE NOT (${identity('c.request_id')}) OR NOT EXISTS
 (SELECT 1 FROM task_runs r WHERE r.id=c.run_id AND r.session_id=c.session_id);
CREATE VIEW invalid_run_identity AS SELECT r.id FROM task_runs r WHERE
 NOT (${identity('r.request_id')}) OR json_extract(r.data,'$.id') IS NOT r.id
 OR json_extract(r.data,'$.taskId') IS NOT r.task_id OR json_extract(r.data,'$.sessionId') IS NOT r.session_id
 OR json_extract(r.data,'$.requestId') IS NOT r.request_id OR json_extract(r.data,'$.request.requestId') IS NOT r.request_id
 OR json_extract(r.data,'$.attempt') IS NOT r.attempt OR json_extract(r.data,'$.status') IS NOT r.status
 OR json_extract(r.data,'$.createCommandId') IS NOT r.create_command_id OR json_extract(r.data,'$.enqueueCommandId') IS NOT r.enqueue_command_id
 OR json_type(r.data,'$.fingerprint') IS NOT 'text' OR length(json_extract(r.data,'$.fingerprint'))<>64
 OR json_extract(r.data,'$.fingerprint') GLOB '*[^0-9a-f]*'
 OR json_type(r.data,'$.request') IS NOT 'object' OR json_type(r.data,'$.snapshot') IS NOT 'object'
 OR json_extract(r.data,'$.request.mode') IS NULL OR json_extract(r.data,'$.request.mode') NOT IN ('new','reuse')
 OR (json_extract(r.data,'$.request.mode')='new' AND json_type(r.data,'$.request.reuseSessionId') IS NOT 'null')
 OR (json_extract(r.data,'$.request.mode')='reuse' AND json_extract(r.data,'$.request.reuseSessionId') IS NOT r.session_id)
 OR json_type(r.data,'$.request.prompt') IS NOT 'text' OR length(trim(json_extract(r.data,'$.request.prompt')))=0
 ${['workspaceId', 'workerId', 'agentKey', 'modelId'].map(key => `OR NOT (${identity(`json_extract(r.data,'$.snapshot.${key}')`)}) OR json_extract(r.data,'$.request.assignment.${key}') IS NOT json_extract(r.data,'$.snapshot.${key}')`).join('\n')}
 OR NOT EXISTS (SELECT 1 FROM records s JOIN tasks t ON t.id=r.task_id WHERE s.kind='session' AND s.id=r.session_id
   AND (json_extract(r.data,'$.request.mode')<>'new' OR s.source_run_id=r.id)
   AND json_extract(r.data,'$.projectId')=t.project_id AND json_extract(s.data,'$.projectId')=t.project_id AND ${binding('s.data', 'r.data')});
CREATE VIEW invalid_cancel_dispatch AS SELECT r.id FROM task_runs r WHERE
 json_type(r.data,'$.cancelCommandIds') IS NOT 'array'
 OR (SELECT count(*) FROM json_each(r.data,'$.cancelCommandIds'))<>(SELECT count(DISTINCT value) FROM json_each(r.data,'$.cancelCommandIds'))
 OR EXISTS (SELECT 1 FROM json_each(r.data,'$.cancelCommandIds') j WHERE j.type<>'text' OR NOT EXISTS
   (SELECT 1 FROM commands c WHERE c.id=j.value AND c.worker_id=json_extract(r.data,'$.snapshot.workerId')
    AND json_extract(c.data,'$.commandId')=c.id AND json_extract(c.data,'$.workerId')=c.worker_id
    AND json_extract(c.data,'$.command.sessionId')=r.session_id
    AND ((json_extract(c.data,'$.command.kind')='session.cancel-queued' AND json_extract(c.data,'$.command.submissionCommandId')=r.enqueue_command_id)
      OR (json_extract(c.data,'$.command.kind')='turn.stop' AND json_extract(c.data,'$.command.turnId')=json_extract(r.data,'$.turnId') AND length(json_extract(r.data,'$.turnId'))>0))))
 OR EXISTS (SELECT 1 FROM json_each(r.data,'$.cancelCommandIds') j JOIN task_runs other ON other.id<>r.id
   JOIN json_each(other.data,'$.cancelCommandIds') k ON k.value=j.value);
CREATE VIEW invalid_session_source AS SELECT s.id FROM records s WHERE s.kind='session' AND (
 json_extract(s.data,'$.id') IS NOT s.id
 OR (json_extract(s.data,'$.taskId') IS NULL AND s.source_run_id IS NOT NULL)
 OR (json_extract(s.data,'$.taskId') IS NOT NULL AND json_type(s.data,'$.runId') IS NULL)
 OR (json_extract(s.data,'$.taskId') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=json_extract(s.data,'$.taskId') AND t.project_id=json_extract(s.data,'$.projectId')))
 OR (s.source_run_id IS NOT NULL AND (json_type(s.data,'$.runId') IS NOT 'text' OR length(s.source_run_id)=0))
 OR EXISTS (SELECT 1 FROM task_runs r WHERE r.id=s.source_run_id AND
   (r.session_id<>s.id OR r.task_id IS NOT json_extract(s.data,'$.taskId') OR NOT (${binding('s.data', 'r.data')}) OR json_extract(r.data,'$.request.mode') IS NOT 'new')));
CREATE TABLE run_invariant_preflight (valid INTEGER CONSTRAINT legacy_run_invariant_violation CHECK(valid=1));
INSERT INTO run_invariant_preflight SELECT 0 WHERE EXISTS(SELECT 1 FROM invalid_cancel_requests)
 OR EXISTS(SELECT 1 FROM invalid_run_identity) OR EXISTS(SELECT 1 FROM invalid_cancel_dispatch)
 OR EXISTS(SELECT 1 FROM invalid_session_source)
 OR EXISTS(SELECT 1 FROM records s WHERE s.source_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.id=s.source_run_id));
DROP TABLE run_invariant_preflight;
DROP TRIGGER session_creation_provenance;
CREATE TRIGGER session_creation_provenance BEFORE UPDATE ON records WHEN OLD.kind='session' AND
 (NEW.kind IS NOT OLD.kind OR NEW.id IS NOT OLD.id
 OR json_extract(NEW.data,'$.taskId') IS NOT json_extract(OLD.data,'$.taskId')
 OR json_extract(NEW.data,'$.runId') IS NOT json_extract(OLD.data,'$.runId')
 OR json_extract(NEW.data,'$.binding.workspaceId') IS NOT json_extract(OLD.data,'$.binding.workspaceId')
 OR json_extract(NEW.data,'$.binding.agent') IS NOT json_extract(OLD.data,'$.binding.agent'))
 BEGIN SELECT RAISE(ABORT,'Session creation provenance is immutable'); END;
CREATE TRIGGER run_identity_immutable BEFORE UPDATE ON task_runs WHEN
 NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id OR NEW.request_id IS NOT OLD.request_id
 OR NEW.session_id IS NOT OLD.session_id OR NEW.attempt IS NOT OLD.attempt OR NEW.session_kind IS NOT OLD.session_kind
 OR NEW.create_command_id IS NOT OLD.create_command_id OR NEW.enqueue_command_id IS NOT OLD.enqueue_command_id
 OR json_extract(NEW.data,'$.request') IS NOT json_extract(OLD.data,'$.request')
 OR json_extract(NEW.data,'$.snapshot') IS NOT json_extract(OLD.data,'$.snapshot')
 OR json_extract(NEW.data,'$.fingerprint') IS NOT json_extract(OLD.data,'$.fingerprint')
 BEGIN SELECT RAISE(ABORT,'Immutable Run identity changed'); END;
CREATE TRIGGER cancel_identity_immutable BEFORE UPDATE ON run_cancel_requests WHEN
 NEW.run_id IS NOT OLD.run_id OR NEW.request_id IS NOT OLD.request_id OR NEW.session_id IS NOT OLD.session_id
 BEGIN SELECT RAISE(ABORT,'Cancel request identity is immutable'); END;
${['INSERT', 'UPDATE'].map(op => `
CREATE TRIGGER cancel_request_${op.toLowerCase()} AFTER ${op} ON run_cancel_requests
 WHEN EXISTS(SELECT 1 FROM invalid_cancel_requests WHERE row_id=NEW.rowid)
 BEGIN SELECT RAISE(ABORT,'Invalid cancel request identity or Session'); END;
CREATE TRIGGER run_invariants_${op.toLowerCase()} AFTER ${op} ON task_runs BEGIN
 SELECT RAISE(ABORT,'Invalid Run identity or binding') WHERE EXISTS(SELECT 1 FROM invalid_run_identity WHERE id=NEW.id);
 SELECT RAISE(ABORT,'Invalid Run cancellation dispatch') WHERE EXISTS(SELECT 1 FROM invalid_cancel_dispatch WHERE id=NEW.id);
 SELECT RAISE(ABORT,'Invalid Session source') WHERE EXISTS(SELECT 1 FROM invalid_session_source);
 END;
CREATE TRIGGER session_source_${op.toLowerCase()} AFTER ${op} ON records WHEN NEW.kind='session' BEGIN
 SELECT RAISE(ABORT,'Invalid Session source') WHERE EXISTS(SELECT 1 FROM invalid_session_source WHERE id=NEW.id);
 SELECT RAISE(ABORT,'Invalid Run identity or binding') WHERE EXISTS(SELECT 1 FROM invalid_run_identity r JOIN task_runs t ON t.id=r.id WHERE t.session_id=NEW.id);
 END;`).join('\n')}
CREATE TRIGGER source_task_insert AFTER INSERT ON tasks
 WHEN EXISTS(SELECT 1 FROM invalid_session_source) OR EXISTS(SELECT 1 FROM invalid_run_identity)
 BEGIN SELECT RAISE(ABORT,'Invalid Session source'); END;
CREATE TRIGGER source_task_update AFTER UPDATE ON tasks
 WHEN EXISTS(SELECT 1 FROM invalid_session_source) OR EXISTS(SELECT 1 FROM invalid_run_identity)
 BEGIN SELECT RAISE(ABORT,'Invalid Session source'); END;
CREATE TRIGGER source_task_delete BEFORE DELETE ON tasks
 WHEN EXISTS(SELECT 1 FROM records WHERE kind='session' AND json_extract(data,'$.taskId')=OLD.id)
 BEGIN SELECT RAISE(ABORT,'Session source Task is referenced'); END;
CREATE TRIGGER cancel_command_insert AFTER INSERT ON commands
 WHEN EXISTS(SELECT 1 FROM invalid_cancel_dispatch)
 BEGIN SELECT RAISE(ABORT,'Invalid Run cancellation dispatch'); END;
CREATE TRIGGER cancel_command_update AFTER UPDATE ON commands
 WHEN EXISTS(SELECT 1 FROM invalid_cancel_dispatch)
 BEGIN SELECT RAISE(ABORT,'Invalid Run cancellation dispatch'); END;
CREATE TRIGGER cancel_command_delete BEFORE DELETE ON commands
 WHEN EXISTS(SELECT 1 FROM task_runs r JOIN json_each(r.data,'$.cancelCommandIds') j WHERE j.value=OLD.id)
 BEGIN SELECT RAISE(ABORT,'Run cancellation dispatch is referenced'); END;
CREATE TRIGGER session_source_replace BEFORE INSERT ON records WHEN NEW.kind='session' AND EXISTS
 (SELECT 1 FROM records s WHERE s.kind=NEW.kind AND s.id=NEW.id AND
 (json_extract(s.data,'$.taskId') IS NOT json_extract(NEW.data,'$.taskId') OR json_extract(s.data,'$.runId') IS NOT json_extract(NEW.data,'$.runId')
 OR json_extract(s.data,'$.binding.workspaceId') IS NOT json_extract(NEW.data,'$.binding.workspaceId')
 OR json_extract(s.data,'$.binding.agent') IS NOT json_extract(NEW.data,'$.binding.agent')))
 BEGIN SELECT RAISE(ABORT,'Session creation provenance is immutable'); END;
CREATE TRIGGER run_identity_replace BEFORE INSERT ON task_runs WHEN EXISTS(SELECT 1 FROM task_runs WHERE id=NEW.id AND
 (task_id IS NOT NEW.task_id OR session_id IS NOT NEW.session_id OR request_id IS NOT NEW.request_id OR attempt IS NOT NEW.attempt
 OR create_command_id IS NOT NEW.create_command_id OR enqueue_command_id IS NOT NEW.enqueue_command_id
 OR json_extract(data,'$.request') IS NOT json_extract(NEW.data,'$.request') OR json_extract(data,'$.snapshot') IS NOT json_extract(NEW.data,'$.snapshot') OR json_extract(data,'$.fingerprint') IS NOT json_extract(NEW.data,'$.fingerprint')))
 BEGIN SELECT RAISE(ABORT,'Immutable Run identity changed'); END;
`
