import { identity } from './run-invariants.ts'

// A Run preserves its launch request. Session model selection may change for later
// Turns, but Task/Workspace/Worker/Agent provenance remains fixed. Append-only
// migration: existing databases must receive the same rule as fresh databases.
const binding = (session: string, run: string) => `json_extract(${session},'$.binding.workspaceId') IS json_extract(${run},'$.snapshot.workspaceId')
  AND json_extract(${session},'$.binding.agent.workerId') IS json_extract(${run},'$.snapshot.workerId')
  AND json_extract(${session},'$.binding.agent.agentKey') IS json_extract(${run},'$.snapshot.agentKey')`

export const sessionModelSelectionMigration = `
DROP VIEW invalid_run_identity;
DROP VIEW invalid_session_source;
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
CREATE VIEW invalid_session_source AS SELECT s.id FROM records s WHERE s.kind='session' AND (
 json_extract(s.data,'$.id') IS NOT s.id
 OR (json_extract(s.data,'$.taskId') IS NULL AND s.source_run_id IS NOT NULL)
 OR (json_extract(s.data,'$.taskId') IS NOT NULL AND json_type(s.data,'$.runId') IS NULL)
 OR (json_extract(s.data,'$.taskId') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id=json_extract(s.data,'$.taskId') AND t.project_id=json_extract(s.data,'$.projectId')))
 OR (s.source_run_id IS NOT NULL AND (json_type(s.data,'$.runId') IS NOT 'text' OR length(s.source_run_id)=0))
 OR EXISTS (SELECT 1 FROM task_runs r WHERE r.id=s.source_run_id AND
   (r.session_id<>s.id OR r.task_id IS NOT json_extract(s.data,'$.taskId') OR NOT (${binding('s.data', 'r.data')}) OR json_extract(r.data,'$.request.mode') IS NOT 'new')));
`
