// Preserve ordinary Project Task provenance while permitting a Team coordination Task
// to anchor a Session whose actual Workspace and execution belong to a Project.
// An anchor cannot authorize a Run; it may only back a direct conversation Session.
export const teamCoordinationSourceMigration = `
DROP TRIGGER session_task_scope;
CREATE TRIGGER session_task_scope BEFORE UPDATE ON records
 WHEN NEW.kind='session' AND json_extract(NEW.data,'$.taskId') IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=json_extract(NEW.data,'$.taskId') AND
   (t.project_id=json_extract(NEW.data,'$.projectId') OR (
    json_extract(NEW.data,'$.runId') IS NULL AND json_type(t.data,'$.teamCoordination')='object'
    AND t.project_id='team:' || json_extract(t.data,'$.teamCoordination.teamId')
    AND json_extract(t.data,'$.teamCoordination.ownerId')=json_extract(NEW.data,'$.ownerId')
    AND json_extract(t.data,'$.teamCoordination.workerId')=json_extract(NEW.data,'$.binding.agent.workerId')
    AND json_extract(t.data,'$.teamCoordination.agentKey')=json_extract(NEW.data,'$.binding.agent.agentKey')
    AND EXISTS (SELECT 1 FROM records p WHERE p.kind='project' AND p.id=json_extract(NEW.data,'$.projectId')
     AND json_extract(p.data,'$.teamId')=json_extract(t.data,'$.teamCoordination.teamId')))))
 BEGIN SELECT RAISE(ABORT, 'Session Task project mismatch'); END;
DROP VIEW invalid_session_source;
CREATE VIEW invalid_session_source AS SELECT s.id FROM records s WHERE s.kind='session' AND (
 json_extract(s.data,'$.id') IS NOT s.id
 OR (json_extract(s.data,'$.taskId') IS NULL AND s.source_run_id IS NOT NULL)
 OR (json_extract(s.data,'$.taskId') IS NOT NULL AND json_type(s.data,'$.runId') IS NULL)
 OR (json_extract(s.data,'$.taskId') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=json_extract(s.data,'$.taskId') AND
    (t.project_id=json_extract(s.data,'$.projectId') OR (
      s.source_run_id IS NULL AND json_type(t.data,'$.teamCoordination')='object'
      AND t.project_id='team:' || json_extract(t.data,'$.teamCoordination.teamId')
      AND json_extract(t.data,'$.teamCoordination.ownerId')=json_extract(s.data,'$.ownerId')
      AND json_extract(t.data,'$.teamCoordination.workerId')=json_extract(s.data,'$.binding.agent.workerId')
      AND json_extract(t.data,'$.teamCoordination.agentKey')=json_extract(s.data,'$.binding.agent.agentKey')
      AND EXISTS (SELECT 1 FROM records p WHERE p.kind='project' AND p.id=json_extract(s.data,'$.projectId')
       AND json_extract(p.data,'$.teamId')=json_extract(t.data,'$.teamCoordination.teamId'))))))
 OR (s.source_run_id IS NOT NULL AND (json_type(s.data,'$.runId') IS NOT 'text' OR length(s.source_run_id)=0))
 OR EXISTS (SELECT 1 FROM task_runs r WHERE r.id=s.source_run_id AND
   (r.session_id<>s.id OR r.task_id IS NOT json_extract(s.data,'$.taskId')
   OR json_extract(s.data,'$.binding.workspaceId') IS NOT json_extract(r.data,'$.snapshot.workspaceId')
   OR json_extract(s.data,'$.binding.agent.workerId') IS NOT json_extract(r.data,'$.snapshot.workerId')
   OR json_extract(s.data,'$.binding.agent.agentKey') IS NOT json_extract(r.data,'$.snapshot.agentKey')
   OR json_extract(r.data,'$.request.mode') IS NOT 'new')));
`
