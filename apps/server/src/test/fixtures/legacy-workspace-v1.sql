-- Schema v1, before tasks and Workspace provisioning attempt metadata existed.
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
INSERT INTO schema_migrations VALUES(1);
CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind,id));
CREATE TABLE commands (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, projection TEXT NOT NULL);
CREATE INDEX commands_delivery ON commands(worker_id,status);
CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq > 0), data TEXT NOT NULL, PRIMARY KEY(session_id,seq));
INSERT INTO records VALUES('worker', 'legacy-worker', '{"id":"legacy-worker","teamId":"default-team","ownerId":"bootstrap-admin","name":"Legacy worker","shareScope":"owner-only","connectionState":"offline","version":null,"platform":null,"capabilities":[],"lastSeenAt":null}');
INSERT INTO records VALUES('workspace', 'legacy-workspace', '{"id":"legacy-workspace","projectId":"default-project","workerId":"legacy-worker","name":"Legacy workspace","spec":{"kind":"composite","memberWorkspaceIds":[]},"status":"pending","failureReason":null,"location":null}');
INSERT INTO commands VALUES('legacy-provision', 'legacy-worker', 'pending', '{"commandId":"legacy-provision","workerId":"legacy-worker","command":{"kind":"workspace.provision","workspace":{"workspace":{"id":"legacy-workspace","projectId":"default-project","workerId":"legacy-worker","name":"Legacy workspace","spec":{"kind":"composite","memberWorkspaceIds":[]},"status":"pending","failureReason":null},"repositories":[]}},"payloadFingerprint":"legacy-fingerprint","createdAt":"2025-01-01T00:00:00.000Z"}', '{"commandId":"legacy-provision","workerId":"legacy-worker","payloadFingerprint":"legacy-fingerprint","status":"pending","createdAt":"2025-01-01T00:00:00.000Z","updatedAt":"2025-01-01T00:00:00.000Z"}');
