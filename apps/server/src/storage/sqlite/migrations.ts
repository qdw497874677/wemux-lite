import type { DatabaseSync } from 'node:sqlite'
import { runInvariants } from './run-invariants.js'
import { retentionDestinationInvariants, retentionInvariants } from './retention-invariants.js'

const migrations = [
  `CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind,id));
   CREATE TABLE commands (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, projection TEXT NOT NULL);
   CREATE INDEX commands_delivery ON commands(worker_id,status);
   CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq > 0), data TEXT NOT NULL, PRIMARY KEY(session_id,seq));`,
  `CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
     CHECK(json_extract(data,'$.metadataJson.schemaVersion') = 1));
   CREATE INDEX tasks_project ON tasks(project_id);
   CREATE TABLE task_activity (task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL CHECK(seq > 0), data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(task_id,seq));`,
  `CREATE TABLE task_workspaces (
     task_id TEXT NOT NULL REFERENCES tasks(id),
     project_id TEXT NOT NULL,
     workspace_kind TEXT NOT NULL DEFAULT 'workspace' CHECK(workspace_kind='workspace'),
     workspace_id TEXT NOT NULL UNIQUE,
     project_kind TEXT NOT NULL DEFAULT 'project' CHECK(project_kind='project'),
     created_at TEXT NOT NULL,
     PRIMARY KEY(task_id,workspace_id),
     FOREIGN KEY(workspace_kind,workspace_id) REFERENCES records(kind,id),
     FOREIGN KEY(project_kind,project_id) REFERENCES records(kind,id));
   CREATE INDEX task_workspaces_task ON task_workspaces(task_id);
   CREATE TRIGGER task_workspaces_project BEFORE INSERT ON task_workspaces
   WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE id=NEW.task_id AND project_id=NEW.project_id)
     OR NOT EXISTS (SELECT 1 FROM records WHERE kind='workspace' AND id=NEW.workspace_id AND json_extract(data,'$.projectId')=NEW.project_id)
   BEGIN SELECT RAISE(ABORT, 'Workspace project mismatch'); END;`,
  // Recover the actual attempt history from durable commands, not retry request aliases.
  `UPDATE records SET data=json_set(data, '$.provisioning.replacedAttempt', json(CASE WHEN
     (SELECT COUNT(*) FROM commands WHERE json_extract(commands.data,'$.command.kind')='workspace.provision'
       AND json_extract(commands.data,'$.command.workspace.workspace.id')=records.id) > 1
     THEN 'true' ELSE 'false' END))
   WHERE kind='workspace' AND json_type(data,'$.provisioning')='object'
     AND json_type(data,'$.provisioning.replacedAttempt') IS NULL;`,
  `CREATE TABLE task_runs (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL REFERENCES tasks(id),
     request_id TEXT NOT NULL,
     attempt INTEGER NOT NULL CHECK(attempt > 0),
     status TEXT NOT NULL CHECK(status IN ('pending','running','cancelling','succeeded','failed','cancelled')),
     session_kind TEXT NOT NULL DEFAULT 'session' CHECK(session_kind='session'),
     session_id TEXT NOT NULL,
     create_command_id TEXT REFERENCES commands(id),
     enqueue_command_id TEXT NOT NULL UNIQUE REFERENCES commands(id),
     data TEXT NOT NULL CHECK(json_valid(data)),
     FOREIGN KEY(session_kind,session_id) REFERENCES records(kind,id),
     UNIQUE(task_id,request_id), UNIQUE(task_id,attempt));
   CREATE UNIQUE INDEX task_runs_active ON task_runs(task_id) WHERE status IN ('pending','running','cancelling');
   CREATE INDEX task_runs_session ON task_runs(session_id);
   CREATE TABLE command_dependencies (
     command_id TEXT PRIMARY KEY REFERENCES commands(id),
     prerequisite_id TEXT NOT NULL REFERENCES commands(id),
     CHECK(command_id <> prerequisite_id));
   ALTER TABLE task_activity ADD COLUMN source_key TEXT;
   CREATE UNIQUE INDEX task_activity_source ON task_activity(task_id,source_key) WHERE source_key IS NOT NULL;`,
  `CREATE TABLE run_cancel_requests (
     run_id TEXT NOT NULL REFERENCES task_runs(id), request_id TEXT NOT NULL,
     session_id TEXT NOT NULL, PRIMARY KEY(run_id,request_id));
   CREATE TRIGGER run_session_scope BEFORE INSERT ON task_runs
   WHEN NOT EXISTS (SELECT 1 FROM records s JOIN tasks t ON t.id=NEW.task_id
     WHERE s.kind='session' AND s.id=NEW.session_id AND json_extract(s.data,'$.projectId')=t.project_id
       AND json_extract(s.data,'$.deletedAt') IS NULL)
   BEGIN SELECT RAISE(ABORT, 'Run Session project mismatch or deleted'); END;
   CREATE TRIGGER active_run_session_delete BEFORE UPDATE ON records
   WHEN NEW.kind='session' AND json_extract(NEW.data,'$.deletedAt') IS NOT NULL
     AND EXISTS (SELECT 1 FROM task_runs WHERE session_id=NEW.id AND status IN ('pending','running','cancelling'))
   BEGIN SELECT RAISE(ABORT, 'Session has active Run'); END;`,
  `CREATE TRIGGER session_creation_provenance BEFORE UPDATE ON records
   WHEN NEW.kind='session' AND json_extract(OLD.data,'$.taskId') IS NOT NULL
     AND (json_extract(NEW.data,'$.taskId') IS NOT json_extract(OLD.data,'$.taskId')
       OR json_extract(NEW.data,'$.runId') IS NOT json_extract(OLD.data,'$.runId'))
   BEGIN SELECT RAISE(ABORT, 'Session creation provenance is immutable'); END;
   CREATE TRIGGER session_task_scope BEFORE UPDATE ON records
   WHEN NEW.kind='session' AND json_extract(NEW.data,'$.taskId') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM tasks WHERE id=json_extract(NEW.data,'$.taskId') AND project_id=json_extract(NEW.data,'$.projectId'))
   BEGIN SELECT RAISE(ABORT, 'Session Task project mismatch'); END;`,
  runInvariants,
  retentionInvariants,
  retentionDestinationInvariants,
  `CREATE TABLE review_requests (
     id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES task_runs(id),
     task_id TEXT NOT NULL REFERENCES tasks(id), project_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK(status IN ('requested','approved','changes_requested')),
     data TEXT NOT NULL CHECK(json_valid(data)));
   CREATE INDEX review_requests_pending ON review_requests(project_id,status);
   CREATE TRIGGER review_scope BEFORE INSERT ON review_requests
   WHEN NOT EXISTS (SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.task_id
     WHERE r.id=NEW.run_id AND t.id=NEW.task_id AND t.project_id=NEW.project_id
       AND r.status IN ('succeeded','failed','cancelled'))
   BEGIN SELECT RAISE(ABORT, 'Review requires terminal Run in Task project'); END;
   CREATE TRIGGER review_identity BEFORE UPDATE ON review_requests
   WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.task_id IS NOT OLD.task_id
     OR NEW.project_id IS NOT OLD.project_id OR OLD.status <> 'requested'
     OR json_extract(NEW.data,'$.actor') IS NOT json_extract(OLD.data,'$.actor')
     OR json_extract(NEW.data,'$.requestedAt') IS NOT json_extract(OLD.data,'$.requestedAt')
   BEGIN SELECT RAISE(ABORT, 'Review identity or final decision is immutable'); END;
   CREATE TABLE project_activity (
     cursor INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
     task_id TEXT NOT NULL, seq INTEGER NOT NULL,
     UNIQUE(task_id,seq), FOREIGN KEY(task_id,seq) REFERENCES task_activity(task_id,seq));
   CREATE INDEX project_activity_cursor ON project_activity(project_id,cursor);
   INSERT INTO project_activity(project_id,task_id,seq)
     SELECT t.project_id,a.task_id,a.seq FROM task_activity a JOIN tasks t ON t.id=a.task_id ORDER BY a.rowid;
   CREATE TRIGGER project_activity_append AFTER INSERT ON task_activity
   BEGIN INSERT INTO project_activity(project_id,task_id,seq)
     SELECT project_id,NEW.task_id,NEW.seq FROM tasks WHERE id=NEW.task_id; END;`,
  // Human workflow may enter review while execution is active; decisions remain guarded by the service.
  `DROP TRIGGER review_scope;
   CREATE TRIGGER review_scope BEFORE INSERT ON review_requests
   WHEN NOT EXISTS (SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.task_id
     WHERE r.id=NEW.run_id AND t.id=NEW.task_id AND t.project_id=NEW.project_id)
   BEGIN SELECT RAISE(ABORT, 'Review requires Run in Task project'); END;`,
  // A Run may participate in multiple human review cycles. Decisions remain immutable.
  `DROP TRIGGER review_scope;
   DROP TRIGGER review_identity;
   ALTER TABLE review_requests RENAME TO old_review_requests;
   CREATE TABLE review_requests (
     id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES task_runs(id),
     task_id TEXT NOT NULL REFERENCES tasks(id), project_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK(status IN ('requested','approved','changes_requested')),
     data TEXT NOT NULL CHECK(json_valid(data)),
     CHECK(json_extract(data,'$.id') IS id AND json_extract(data,'$.taskRunId') IS run_id
       AND json_extract(data,'$.taskId') IS task_id AND json_extract(data,'$.projectId') IS project_id
       AND json_extract(data,'$.status') IS status),
     CHECK(json_type(data,'$.actor') IS 'text' AND length(trim(json_extract(data,'$.actor'))) > 0
       AND datetime(json_extract(data,'$.requestedAt')) IS NOT NULL
       AND (json_type(data,'$.closedAt') IS 'null' OR (json_type(data,'$.closedAt') IS 'text'
         AND julianday(json_extract(data,'$.closedAt')) IS NOT NULL
         AND julianday(json_extract(data,'$.closedAt')) >= julianday(json_extract(data,'$.requestedAt'))))),
     CHECK((status='requested' AND json_type(data,'$.reviewer') IS 'null' AND json_type(data,'$.decidedAt') IS 'null')
       OR (status<>'requested' AND json_type(data,'$.reviewer') IS 'text' AND length(trim(json_extract(data,'$.reviewer'))) > 0
         AND julianday(json_extract(data,'$.decidedAt')) IS NOT NULL
         AND julianday(json_extract(data,'$.decidedAt')) >= julianday(json_extract(data,'$.requestedAt'))
         AND json_extract(data,'$.closedAt') IS json_extract(data,'$.decidedAt'))));
   INSERT INTO review_requests SELECT id,run_id,task_id,project_id,status,
     json_set(data,'$.closedAt',CASE WHEN status='requested' THEN NULL ELSE json_extract(data,'$.decidedAt') END) FROM old_review_requests;
   DROP TABLE old_review_requests;
   UPDATE tasks SET data=json_set(data,'$.currentReviewId',NULL);
   UPDATE tasks SET data=json_set(data,'$.currentReviewId',
     (SELECT v.id FROM review_requests v JOIN task_runs r ON r.id=v.run_id
       WHERE v.task_id=tasks.id AND v.status='requested' AND r.attempt=(SELECT MAX(attempt) FROM task_runs WHERE task_id=tasks.id)))
     WHERE json_extract(data,'$.status')='in_review';
   UPDATE review_requests SET data=json_set(data,'$.closedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     WHERE status='requested' AND id NOT IN (SELECT json_extract(data,'$.currentReviewId') FROM tasks WHERE json_extract(data,'$.currentReviewId') IS NOT NULL);
   CREATE TEMP TABLE recovered_reviews AS SELECT lower(hex(randomblob(16))) AS id,r.id AS run_id,t.id AS task_id,t.project_id
     FROM tasks t JOIN task_runs r ON r.task_id=t.id
     WHERE json_extract(t.data,'$.status')='in_review' AND json_extract(t.data,'$.currentReviewId') IS NULL
       AND r.attempt=(SELECT MAX(attempt) FROM task_runs WHERE task_id=t.id);
   INSERT INTO review_requests SELECT id,run_id,task_id,project_id,'requested',
     json_object('id',id,'taskRunId',run_id,'taskId',task_id,'projectId',project_id,'status','requested',
       'actor','migration','reviewer',NULL,'requestedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'decidedAt',NULL,'closedAt',NULL) FROM recovered_reviews;
   UPDATE tasks SET data=json_set(data,'$.currentReviewId',(SELECT id FROM recovered_reviews WHERE task_id=tasks.id)) WHERE id IN (SELECT task_id FROM recovered_reviews);
   DROP TABLE recovered_reviews;
   CREATE INDEX review_requests_pending ON review_requests(project_id,status);
   CREATE UNIQUE INDEX review_current_task ON review_requests(task_id) WHERE status='requested' AND json_extract(data,'$.closedAt') IS NULL;
   CREATE TRIGGER review_scope BEFORE INSERT ON review_requests
   WHEN NOT EXISTS (SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.task_id
     WHERE r.id=NEW.run_id AND t.id=NEW.task_id AND t.project_id=NEW.project_id)
   BEGIN SELECT RAISE(ABORT, 'Review requires Run in Task project'); END;
   CREATE TRIGGER review_identity BEFORE UPDATE ON review_requests
   WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.task_id IS NOT OLD.task_id
     OR NEW.project_id IS NOT OLD.project_id OR OLD.status <> 'requested' OR json_extract(OLD.data,'$.closedAt') IS NOT NULL
     OR json_extract(NEW.data,'$.actor') IS NOT json_extract(OLD.data,'$.actor')
     OR json_extract(NEW.data,'$.requestedAt') IS NOT json_extract(OLD.data,'$.requestedAt')
   BEGIN SELECT RAISE(ABORT, 'Review identity or final decision is immutable'); END;`,
]

export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys=ON')
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)')
  for (const [index, sql] of migrations.entries()) {
    const version = index + 1
    if (db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(version)) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(version)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
