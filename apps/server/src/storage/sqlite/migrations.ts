import type { DatabaseSync } from 'node:sqlite'
import { runInvariants } from './run-invariants.js'
import { retentionDestinationInvariants, retentionInvariants } from './retention-invariants.js'

const legacyMigrations = [
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
     AND json_type(data,'$.provisioning.replacedAttempt') IS NULL;
   UPDATE records SET data=json_set(data, '$.placements[0].provisioning.replacedAttempt', json(CASE WHEN
     (SELECT COUNT(*) FROM commands WHERE json_extract(commands.data,'$.command.kind')='workspace.provision'
       AND json_extract(commands.data,'$.command.workspace.workspace.id')=records.id) > 1
     THEN 'true' ELSE 'false' END))
   WHERE kind='workspace' AND json_type(data,'$.placements[0].provisioning')='object'
     AND json_type(data,'$.placements[0].provisioning.replacedAttempt') IS NULL;`,
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
  `CREATE UNIQUE INDEX IF NOT EXISTS session_create_request ON records(
     json_extract(data,'$.ownerId'), json_extract(data,'$.projectId'), json_extract(data,'$.creation.requestId'))
   WHERE kind='session' AND json_type(data,'$.creation.requestId')='text';
   CREATE TRIGGER IF NOT EXISTS session_creation_identity BEFORE UPDATE ON records
   WHEN OLD.kind='session' AND json_type(OLD.data,'$.creation')='object'
     AND (json_extract(NEW.data,'$.creation.requestId') IS NOT json_extract(OLD.data,'$.creation.requestId')
       OR json_extract(NEW.data,'$.creation.fingerprint') IS NOT json_extract(OLD.data,'$.creation.fingerprint')
       OR json_extract(NEW.data,'$.creation.commandId') IS NOT json_extract(OLD.data,'$.creation.commandId'))
   BEGIN SELECT RAISE(ABORT, 'Session creation identity is immutable'); END;`,
]

/**
 * Ticket 04 账号迁移的第一个版本号（已落地，不再变动）。
 * 列表是 append-only 的：新迁移只能追加在账号迁移之后，升级测试据此构造“升级前实例”镜像。
 */
export const firstAccountMigrationVersion = legacyMigrations.length + 1

const accountMigrations = [
  // Ticket 04：浏览器登录会话与实例认领是独立持久化记录，不再是伪装成 PAT 的凭证。
  `CREATE TABLE IF NOT EXISTS login_sessions (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     csrf_token_hash TEXT NOT NULL,
     revoked_at TEXT,
     data TEXT NOT NULL CHECK(json_valid(data)),
     CHECK(json_extract(data,'$.id') IS id AND json_extract(data,'$.userId') IS user_id
       AND json_extract(data,'$.tokenHash') IS token_hash AND json_extract(data,'$.csrfTokenHash') IS csrf_token_hash
       AND json_extract(data,'$.revokedAt') IS revoked_at),
     CHECK(json_type(data,'$.authenticationMethod') IS 'text' AND length(trim(json_extract(data,'$.authenticationMethod'))) > 0
       AND datetime(json_extract(data,'$.authenticatedAt')) IS NOT NULL
       AND datetime(json_extract(data,'$.createdAt')) IS NOT NULL
       AND datetime(json_extract(data,'$.lastSeenAt')) IS NOT NULL
       AND datetime(json_extract(data,'$.idleExpiresAt')) IS NOT NULL
       AND datetime(json_extract(data,'$.absoluteExpiresAt')) IS NOT NULL),
     CHECK(julianday(json_extract(data,'$.authenticatedAt')) <= julianday(json_extract(data,'$.createdAt'))
       AND julianday(json_extract(data,'$.lastSeenAt')) >= julianday(json_extract(data,'$.createdAt'))
       AND julianday(json_extract(data,'$.idleExpiresAt')) > julianday(json_extract(data,'$.lastSeenAt'))
       AND julianday(json_extract(data,'$.absoluteExpiresAt')) > julianday(json_extract(data,'$.idleExpiresAt'))),
     CHECK(revoked_at IS NULL OR julianday(revoked_at) >= julianday(json_extract(data,'$.createdAt'))));
   CREATE INDEX IF NOT EXISTS login_sessions_user ON login_sessions(user_id);
   CREATE TRIGGER IF NOT EXISTS login_session_identity BEFORE UPDATE ON login_sessions
   WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id
     OR NEW.token_hash IS NOT OLD.token_hash OR NEW.csrf_token_hash IS NOT OLD.csrf_token_hash
     OR json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt')
     OR json_extract(NEW.data,'$.authenticatedAt') IS NOT json_extract(OLD.data,'$.authenticatedAt')
     OR json_extract(NEW.data,'$.absoluteExpiresAt') IS NOT json_extract(OLD.data,'$.absoluteExpiresAt')
     OR json_extract(NEW.data,'$.authenticationMethod') IS NOT json_extract(OLD.data,'$.authenticationMethod')
   BEGIN SELECT RAISE(ABORT, 'Login session identity is immutable'); END;
   CREATE TRIGGER IF NOT EXISTS login_session_monotonic BEFORE UPDATE ON login_sessions
   WHEN julianday(json_extract(NEW.data,'$.lastSeenAt')) < julianday(json_extract(OLD.data,'$.lastSeenAt'))
     OR julianday(json_extract(NEW.data,'$.idleExpiresAt')) < julianday(json_extract(OLD.data,'$.idleExpiresAt'))
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
   BEGIN SELECT RAISE(ABORT, 'Login session must not move backwards'); END;
   CREATE TABLE IF NOT EXISTS instance_claim (
     id TEXT PRIMARY KEY CHECK(id='instance'),
     administrator_user_id TEXT NOT NULL,
     claimed_at TEXT NOT NULL,
     bootstrap_retired_at TEXT NOT NULL,
     data TEXT NOT NULL CHECK(json_valid(data)),
     CHECK(json_extract(data,'$.id') IS id AND json_extract(data,'$.administratorUserId') IS administrator_user_id
       AND json_extract(data,'$.claimedAt') IS claimed_at AND json_extract(data,'$.bootstrapRetiredAt') IS bootstrap_retired_at));
   CREATE TRIGGER IF NOT EXISTS instance_claim_immutable BEFORE UPDATE ON instance_claim
   BEGIN SELECT RAISE(ABORT, 'Instance claim is immutable'); END;`,
  // 旧 `wemux-session-*` 实际上就是 PAT 行；它们在迁移前是无 scope 的（没有有效期），无法表达权限边界，
  // 升级时只退役这批无 scope PAT（设计第 4 节：默认失效并重新签发，而不是猜权限），并留下可审计报告。
  // 带有效期的 PAT 是账号模型之后的产物，自带范围与到期时间，升级不得改写。
  `INSERT INTO records(kind,id,data) SELECT 'audit','upgrade-legacy-pat-retirement', json_object(
     'id','upgrade-legacy-pat-retirement','actorId',NULL,'action','credentials.legacy_pat_retired',
     'resource',json_object('kind','user','id','legacy-credentials'),'result','succeeded',
     'occurredAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
     'metadata',json_object('retiredCount',(SELECT COUNT(*) FROM records WHERE kind='pat' AND json_extract(data,'$.revokedAt') IS NULL AND json_extract(data,'$.expiresAt') IS NULL)))
   WHERE EXISTS (SELECT 1 FROM records WHERE kind='pat' AND json_extract(data,'$.revokedAt') IS NULL AND json_extract(data,'$.expiresAt') IS NULL);
   UPDATE records SET data=json_set(data,'$.revokedAt', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   WHERE kind='pat' AND json_extract(data,'$.revokedAt') IS NULL AND json_extract(data,'$.expiresAt') IS NULL;`,
  // CSRF 令牌需要在浏览器刷新后可重新签发（保留令牌哈希），因此 csrf_token_hash 不属于不可变身份。
  `DROP TRIGGER IF EXISTS login_session_identity;
   CREATE TRIGGER login_session_identity BEFORE UPDATE ON login_sessions
   WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.token_hash IS NOT OLD.token_hash
     OR json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt')
     OR json_extract(NEW.data,'$.authenticatedAt') IS NOT json_extract(OLD.data,'$.authenticatedAt')
     OR json_extract(NEW.data,'$.absoluteExpiresAt') IS NOT json_extract(OLD.data,'$.absoluteExpiresAt')
     OR json_extract(NEW.data,'$.authenticationMethod') IS NOT json_extract(OLD.data,'$.authenticationMethod')
   BEGIN SELECT RAISE(ABORT, 'Login session identity is immutable'); END;`,
  // Ticket 05：主邮箱唯一性与待验证注册是独立持久化记录；待验证注册不产生 User、不授予任何资源权限。
  // 邮箱规范化在应用层用明确规则（去首尾空白、域名转 ASCII、产品级大小写不敏感），回填只用等价的最小规则
  // （trim + lower），并单独报告无法自动归一的历史冲突，不静默合并两个账号。
  `CREATE TABLE IF NOT EXISTS user_emails (
     email_normalized TEXT PRIMARY KEY,
     user_id TEXT NOT NULL UNIQUE,
     user_kind TEXT NOT NULL DEFAULT 'user' CHECK(user_kind='user'),
     email_display TEXT NOT NULL,
     created_at TEXT NOT NULL,
     data TEXT NOT NULL CHECK(json_valid(data)),
     CHECK(json_extract(data,'$.emailNormalized') IS email_normalized
       AND json_extract(data,'$.userId') IS user_id
       AND json_extract(data,'$.emailDisplay') IS email_display),
     CHECK(datetime(created_at) IS NOT NULL),
     CHECK(length(trim(email_normalized)) > 0 AND email_normalized = lower(trim(email_normalized))),
     FOREIGN KEY(user_kind,user_id) REFERENCES records(kind,id));
   CREATE TABLE IF NOT EXISTS registration_attempts (
     id TEXT PRIMARY KEY,
     email_normalized TEXT NOT NULL,
     status TEXT NOT NULL CHECK(status IN ('pending','verified','expired','superseded')),
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     consumed_at TEXT,
     data TEXT NOT NULL CHECK(json_valid(data)),
     CHECK(json_extract(data,'$.id') IS id AND json_extract(data,'$.emailNormalized') IS email_normalized
       AND json_extract(data,'$.status') IS status AND json_extract(data,'$.consumedAt') IS consumed_at
       AND json_type(data,'$.emailDisplay') IS 'text' AND length(trim(json_extract(data,'$.emailDisplay'))) > 0
       AND json_type(data,'$.passwordHash') IS 'text' AND length(json_extract(data,'$.passwordHash')) > 0),
     CHECK(datetime(created_at) IS NOT NULL AND datetime(expires_at) IS NOT NULL
       AND julianday(expires_at) > julianday(created_at)),
     CHECK(consumed_at IS NULL OR julianday(consumed_at) >= julianday(created_at)),
     CHECK((status='pending' AND consumed_at IS NULL)
       OR (status IN ('verified','superseded') AND consumed_at IS NOT NULL)
       OR status='expired'),
     CHECK((status='verified' AND json_type(data,'$.userId') IS 'text') OR (status<>'verified' AND json_type(data,'$.userId') IS 'null')));
   CREATE UNIQUE INDEX IF NOT EXISTS registration_attempts_pending_email ON registration_attempts(email_normalized) WHERE status='pending';
   CREATE INDEX IF NOT EXISTS registration_attempts_email ON registration_attempts(email_normalized);
   CREATE TRIGGER IF NOT EXISTS registration_attempt_identity BEFORE UPDATE ON registration_attempts
   WHEN NEW.id IS NOT OLD.id OR NEW.email_normalized IS NOT OLD.email_normalized
     OR json_extract(NEW.data,'$.passwordHash') IS NOT json_extract(OLD.data,'$.passwordHash')
     OR json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt')
     OR json_extract(NEW.data,'$.expiresAt') IS NOT json_extract(OLD.data,'$.expiresAt')
     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
     OR (OLD.status<>'pending' AND NEW.status IS NOT OLD.status)
   BEGIN SELECT RAISE(ABORT, 'Registration attempt identity is immutable'); END;
   CREATE TABLE IF NOT EXISTS verification_challenges (
     id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','reset_password')),
     target_email TEXT NOT NULL,
     registration_id TEXT REFERENCES registration_attempts(id),
     user_id TEXT,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     consumed_at TEXT,
     data TEXT NOT NULL CHECK(json_valid(data)),
     CHECK(json_extract(data,'$.id') IS id AND json_extract(data,'$.tokenHash') IS token_hash
       AND json_extract(data,'$.purpose') IS purpose AND json_extract(data,'$.targetEmail') IS target_email
       AND json_extract(data,'$.registrationId') IS registration_id AND json_extract(data,'$.userId') IS user_id
       AND json_extract(data,'$.consumedAt') IS consumed_at),
     CHECK((registration_id IS NULL) <> (user_id IS NULL)),
     CHECK(length(trim(target_email)) > 0 AND target_email = lower(trim(target_email))),
     CHECK(datetime(created_at) IS NOT NULL AND datetime(expires_at) IS NOT NULL
       AND julianday(expires_at) > julianday(created_at)),
     CHECK(consumed_at IS NULL OR julianday(consumed_at) >= julianday(created_at)));
   CREATE INDEX IF NOT EXISTS verification_challenges_target ON verification_challenges(target_email,purpose);
   CREATE TRIGGER IF NOT EXISTS verification_challenge_identity BEFORE UPDATE ON verification_challenges
   WHEN NEW.id IS NOT OLD.id OR NEW.token_hash IS NOT OLD.token_hash OR NEW.purpose IS NOT OLD.purpose
     OR NEW.target_email IS NOT OLD.target_email OR NEW.registration_id IS NOT OLD.registration_id
     OR NEW.user_id IS NOT OLD.user_id OR NEW.expires_at IS NOT OLD.expires_at
     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
   BEGIN SELECT RAISE(ABORT, 'Verification challenge identity is immutable'); END;`,
  // 历史实例回填：无法从静态记录判定归属的重复邮箱只报告、不合并；无邮箱或已有冲突的账号保持原样。
  `INSERT INTO records(kind,id,data) SELECT 'audit','upgrade-duplicate-emails', json_object(
     'id','upgrade-duplicate-emails','actorId',NULL,'action','identity.duplicate_emails_reported',
     'resource',json_object('kind','user','id','legacy-identity'),'result','succeeded',
     'occurredAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
     'metadata',json_object('conflictCount',(SELECT COUNT(*) FROM (
       SELECT lower(trim(json_extract(data,'$.email'))) AS email FROM records
       WHERE kind='user' AND json_type(data,'$.email')='text' AND length(trim(json_extract(data,'$.email'))) > 0
       GROUP BY email HAVING COUNT(*) > 1)),'claimedCount',0))
   WHERE EXISTS (SELECT 1 FROM (
     SELECT lower(trim(json_extract(data,'$.email'))) AS email FROM records
     WHERE kind='user' AND json_type(data,'$.email')='text' AND length(trim(json_extract(data,'$.email'))) > 0
     GROUP BY email HAVING COUNT(*) > 1));
   INSERT OR IGNORE INTO user_emails(email_normalized,user_id,email_display,created_at,data)
   SELECT lower(trim(json_extract(data,'$.email'))), id, trim(json_extract(data,'$.email')),
     strftime('%Y-%m-%dT%H:%M:%fZ','now'),
     json_object('emailNormalized',lower(trim(json_extract(data,'$.email'))),'userId',id,
       'emailDisplay',trim(json_extract(data,'$.email')),'createdAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   FROM records WHERE kind='user' AND json_type(data,'$.email')='text'
     AND length(trim(json_extract(data,'$.email'))) > 0
   ORDER BY rowid;`,
  // Ticket 05：实例级注册策略是单例设置。没有记录时由应用层采用默认值（`invite_only`），
  // 不把默认值写进数据库，避免“未设置”与“显式设为默认值”混清。策略可修改，因此不加不可变触发器。
  `CREATE TABLE IF NOT EXISTS instance_settings (
     id TEXT PRIMARY KEY CHECK(id='instance'),
     registration_policy TEXT NOT NULL CHECK(registration_policy IN ('open','invite_only','closed')),
     updated_at TEXT NOT NULL,
     updated_by TEXT,
     data TEXT NOT NULL CHECK(json_valid(data)),
     CHECK(json_extract(data,'$.id') IS id AND json_extract(data,'$.registrationPolicy') IS registration_policy
       AND json_extract(data,'$.updatedAt') IS updated_at AND json_extract(data,'$.updatedBy') IS updated_by),
     CHECK(datetime(updated_at) IS NOT NULL));`,
  // Ticket 07：外部登录身份以规范化的 (issuer, subject) 唯一绑定到 User；邮箱不是主键。
  // `email_at_sign_in` 只记录提供方当时的声明，绝不作为已验证主邮箱，也不参与唯一性判定。
  `CREATE TABLE IF NOT EXISTS login_identities (
     id TEXT PRIMARY KEY,
     provider TEXT NOT NULL CHECK(provider IN ('google')),
     issuer TEXT NOT NULL,
     subject TEXT NOT NULL,
     user_id TEXT NOT NULL,
     user_kind TEXT NOT NULL DEFAULT 'user' CHECK(user_kind='user'),
     last_sign_in_at TEXT NOT NULL,
     data TEXT NOT NULL CHECK(json_valid(data)),
     CHECK(json_extract(data,'$.id') IS id AND json_extract(data,'$.provider') IS provider
       AND json_extract(data,'$.issuer') IS issuer AND json_extract(data,'$.subject') IS subject
       AND json_extract(data,'$.userId') IS user_id AND json_extract(data,'$.lastSignInAt') IS last_sign_in_at),
     CHECK(json_type(data,'$.subject') IS 'text' AND length(trim(subject)) > 0
       AND json_type(data,'$.emailVerified') IN ('true','false')
       AND datetime(json_extract(data,'$.createdAt')) IS NOT NULL AND datetime(last_sign_in_at) IS NOT NULL
       AND julianday(last_sign_in_at) >= julianday(json_extract(data,'$.createdAt'))),
     FOREIGN KEY(user_kind,user_id) REFERENCES records(kind,id));
   CREATE UNIQUE INDEX IF NOT EXISTS login_identities_subject ON login_identities(provider,issuer,subject);
   CREATE INDEX IF NOT EXISTS login_identities_user ON login_identities(user_id);
   CREATE TRIGGER IF NOT EXISTS login_identity_binding BEFORE UPDATE ON login_identities
   WHEN NEW.id IS NOT OLD.id OR NEW.provider IS NOT OLD.provider OR NEW.issuer IS NOT OLD.issuer
     OR NEW.subject IS NOT OLD.subject OR NEW.user_id IS NOT OLD.user_id
     OR json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt')
   BEGIN SELECT RAISE(ABORT, 'Login identity binding is immutable'); END;
   CREATE TRIGGER IF NOT EXISTS login_identity_monotonic BEFORE UPDATE ON login_identities
   WHEN julianday(NEW.last_sign_in_at) < julianday(OLD.last_sign_in_at)
   BEGIN SELECT RAISE(ABORT, 'Login identity must not move backwards'); END;`,
  // Ticket 07：OIDC 登录事务是一次性材料（state/nonce/PKCE verifier）。state 只存哈希，
  // 事务单次消费由 `consumed_at IS NULL` 谓词原子保证，跨浏览器或重放的 state 一律失败。
  `CREATE TABLE IF NOT EXISTS oauth_transactions (
     id TEXT PRIMARY KEY,
     state_hash TEXT NOT NULL UNIQUE,
     provider TEXT NOT NULL CHECK(provider IN ('google')),
     intent TEXT NOT NULL CHECK(intent IN ('login','link')),
     user_id TEXT,
     user_kind TEXT NOT NULL DEFAULT 'user' CHECK(user_kind='user'),
     session_id TEXT,
     session_kind TEXT NOT NULL DEFAULT 'session' CHECK(session_kind='session'),
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     consumed_at TEXT,
     data TEXT NOT NULL CHECK(json_valid(data)),
     CHECK(json_extract(data,'$.id') IS id AND json_extract(data,'$.stateHash') IS state_hash
       AND json_extract(data,'$.provider') IS provider AND json_extract(data,'$.intent') IS intent
       AND json_extract(data,'$.userId') IS user_id AND json_extract(data,'$.sessionId') IS session_id
       AND json_extract(data,'$.consumedAt') IS consumed_at),
     CHECK(json_type(data,'$.nonce') IS 'text' AND length(trim(json_extract(data,'$.nonce'))) > 0
       AND json_type(data,'$.codeVerifier') IS 'text' AND length(trim(json_extract(data,'$.codeVerifier'))) > 0),
     CHECK(datetime(created_at) IS NOT NULL AND datetime(expires_at) IS NOT NULL
       AND julianday(expires_at) > julianday(created_at)),
     CHECK((intent='login' AND user_id IS NULL AND session_id IS NULL)
       OR (intent='link' AND user_id IS NOT NULL AND session_id IS NOT NULL)),
     CHECK(consumed_at IS NULL OR julianday(consumed_at) >= julianday(created_at)),
     -- session_id 指向登录会话（login_sessions 表），不是 records 里 kind='session' 的对话会话，
     -- 因此只对 user_id 建外键；会话归属由应用层校验。
     FOREIGN KEY(user_kind,user_id) REFERENCES records(kind,id));
   CREATE INDEX IF NOT EXISTS oauth_transactions_expiry ON oauth_transactions(expires_at);
   CREATE TRIGGER IF NOT EXISTS oauth_transaction_identity BEFORE UPDATE ON oauth_transactions
   WHEN NEW.id IS NOT OLD.id OR NEW.state_hash IS NOT OLD.state_hash OR NEW.provider IS NOT OLD.provider
     OR NEW.intent IS NOT OLD.intent OR NEW.user_id IS NOT OLD.user_id OR NEW.session_id IS NOT OLD.session_id
     OR json_extract(NEW.data,'$.nonce') IS NOT json_extract(OLD.data,'$.nonce')
     OR json_extract(NEW.data,'$.codeVerifier') IS NOT json_extract(OLD.data,'$.codeVerifier')
     OR json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt')
     OR json_extract(NEW.data,'$.expiresAt') IS NOT json_extract(OLD.data,'$.expiresAt')
     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
   BEGIN SELECT RAISE(ABORT, 'OAuth transaction identity is immutable'); END;`,
  // 修正 oauth_transactions 的会话外键：它曾指向 records(kind='session')（对话会话），
  // 导致 intent='link' 的事务根本无法插入。已有库需要重建表才能去掉这个错误约束。
  `CREATE TABLE oauth_transactions_rebuilt (
     id TEXT PRIMARY KEY,
     state_hash TEXT NOT NULL UNIQUE,
     provider TEXT NOT NULL CHECK(provider IN ('google')),
     intent TEXT NOT NULL CHECK(intent IN ('login','link')),
     user_id TEXT,
     user_kind TEXT NOT NULL DEFAULT 'user' CHECK(user_kind='user'),
     session_id TEXT,
     session_kind TEXT NOT NULL DEFAULT 'session' CHECK(session_kind='session'),
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     consumed_at TEXT,
     data TEXT NOT NULL CHECK(json_valid(data)),
     CHECK(json_extract(data,'$.id') IS id AND json_extract(data,'$.stateHash') IS state_hash
       AND json_extract(data,'$.provider') IS provider AND json_extract(data,'$.intent') IS intent
       AND json_extract(data,'$.userId') IS user_id AND json_extract(data,'$.sessionId') IS session_id
       AND json_extract(data,'$.consumedAt') IS consumed_at),
     CHECK(json_type(data,'$.nonce') IS 'text' AND length(trim(json_extract(data,'$.nonce'))) > 0
       AND json_type(data,'$.codeVerifier') IS 'text' AND length(trim(json_extract(data,'$.codeVerifier'))) > 0),
     CHECK(datetime(created_at) IS NOT NULL AND datetime(expires_at) IS NOT NULL
       AND julianday(expires_at) > julianday(created_at)),
     CHECK((intent='login' AND user_id IS NULL AND session_id IS NULL)
       OR (intent='link' AND user_id IS NOT NULL AND session_id IS NOT NULL)),
     CHECK(consumed_at IS NULL OR julianday(consumed_at) >= julianday(created_at)),
     FOREIGN KEY(user_kind,user_id) REFERENCES records(kind,id));
   INSERT INTO oauth_transactions_rebuilt(id,state_hash,provider,intent,user_id,session_id,created_at,expires_at,consumed_at,data)
     SELECT id,state_hash,provider,intent,user_id,session_id,created_at,expires_at,consumed_at,data FROM oauth_transactions;
   DROP TABLE oauth_transactions;
   ALTER TABLE oauth_transactions_rebuilt RENAME TO oauth_transactions;
   CREATE INDEX IF NOT EXISTS oauth_transactions_expiry ON oauth_transactions(expires_at);
   CREATE TRIGGER IF NOT EXISTS oauth_transaction_identity BEFORE UPDATE ON oauth_transactions
   WHEN NEW.id IS NOT OLD.id OR NEW.state_hash IS NOT OLD.state_hash OR NEW.provider IS NOT OLD.provider
     OR NEW.intent IS NOT OLD.intent OR NEW.user_id IS NOT OLD.user_id OR NEW.session_id IS NOT OLD.session_id
     OR json_extract(NEW.data,'$.nonce') IS NOT json_extract(OLD.data,'$.nonce')
     OR json_extract(NEW.data,'$.codeVerifier') IS NOT json_extract(OLD.data,'$.codeVerifier')
     OR json_extract(NEW.data,'$.createdAt') IS NOT json_extract(OLD.data,'$.createdAt')
     OR json_extract(NEW.data,'$.expiresAt') IS NOT json_extract(OLD.data,'$.expiresAt')
     OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
   BEGIN SELECT RAISE(ABORT, 'OAuth transaction identity is immutable'); END;`,
  // 部署者即管理员：授权根改为启动配置声明的邮箱（`WEMUX_ADMIN_EMAILS`），
  // 单例认领记录与 bootstrap 凭证一起退役。归属改为可多条记录的目录，每条只增不改。
  `CREATE TABLE IF NOT EXISTS instance_administrators (
     user_id TEXT PRIMARY KEY,
     user_kind TEXT NOT NULL DEFAULT 'user' CHECK(user_kind='user'),
     email TEXT NOT NULL,
     assigned_at TEXT NOT NULL,
     source TEXT NOT NULL CHECK(source IN ('declared','recovery')),
     data TEXT NOT NULL CHECK(json_valid(data)),
     CHECK(json_extract(data,'$.userId') IS user_id AND json_extract(data,'$.email') IS email
       AND json_extract(data,'$.assignedAt') IS assigned_at AND json_extract(data,'$.source') IS source),
     CHECK(length(trim(email)) > 0 AND email = lower(trim(email))),
     CHECK(datetime(assigned_at) IS NOT NULL),
     FOREIGN KEY(user_kind,user_id) REFERENCES records(kind,id));
   CREATE INDEX IF NOT EXISTS instance_administrators_email ON instance_administrators(email);
   CREATE TRIGGER IF NOT EXISTS instance_administrator_identity BEFORE UPDATE ON instance_administrators
   WHEN NEW.user_id IS NOT OLD.user_id OR NEW.email IS NOT OLD.email
     OR json_extract(NEW.data,'$.assignedAt') IS NOT json_extract(OLD.data,'$.assignedAt')
     OR json_extract(NEW.data,'$.source') IS NOT json_extract(OLD.data,'$.source')
   BEGIN SELECT RAISE(ABORT, 'Instance administrator identity is immutable'); END;
   DROP TABLE IF EXISTS instance_claim;`,
]

const migrations = [...legacyMigrations, ...accountMigrations]

/** 迁移条目数：升级测试用它验证重放不重复插入版本行，避免硬编码数字后静默失效。 */
export const migrationCount = migrations.length

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
