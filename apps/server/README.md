# Wemux Lite Server MVP

Requires Node **22.13+** (`node:sqlite`; tested on Node 26) and npm workspace dependencies. No external database, framework or broker.

```sh
npm install --workspace @wemux/server --package-lock=false
WEMUX_BOOTSTRAP_TOKEN='replace-with-a-long-random-secret' npm run dev --workspace @wemux/server
npm run typecheck --workspace @wemux/server
npm test --workspace @wemux/server
npm run build --workspace @wemux/server
# Production entry (after build): npm start --workspace @wemux/server
```

Configuration: `WEMUX_BOOTSTRAP_TOKEN` (required, >=16 characters), `WEMUX_DATABASE_PATH` (default `./data/server.sqlite`, relative to workspace), `WEMUX_WORKER_PACKAGE_PATH` (default `<repo>/artifacts/wemux-lite-worker.tgz` regardless of launch directory), `HOST` (default `127.0.0.1`), `PORT` (default `3001`). Root `npm run build` creates the Worker package served at `/downloads/worker.tgz`; `/downloads/install-worker.sh` installs that package directly, while npm still downloads its third-party runtime dependencies from the target machine's configured registry. Plain HTTP/WS is supported on trusted LANs; put TLS in front of it on public or untrusted networks. Never expose bearer secrets in URLs.

## Layers

- `http/`: routing, JSON limits/errors, bearer extraction, SSE transport.
- `application/`: authentication, resource use cases, worker ownership, protocol input validation, durable command orchestration and journal projection. Depends on `application/ports/server-store*`, never SQLite or HTTP/WS.
- `worker-ws/`: authenticated upgrade, connection lifecycle, ordered frame processing, bounded outgoing buffers, command retries, hello timeout and idle detection.
- `storage/sqlite/`: explicit numbered transactional migrations; domain records stored as JSON with indexed command delivery and event sequence tables. `ServerStore` transactions serialize writers and rollback on rejection; callbacks must not nest transactions or perform network/filesystem work.
- `server.ts`: composition and lifecycle. `main.ts`: environment/configuration only.

## HTTP contract

All routes require `Authorization: Bearer <WEMUX_BOOTSTRAP_TOKEN>` except `GET /health`, `POST /workers/enroll`, `GET /downloads/install-worker.sh`, and `GET /downloads/worker.tgz`. The download endpoints are intentionally public so a new host can install before enrollment; anyone who can reach the Server can download the configured artifact. This is intentionally a **single trusted administrator** MVP, not multi-user authorization. Authentication decisions live in `AuthenticationService`, not the HTTP adapter. No cookies, PAT management, grants or user login endpoints yet.

| Method | Route | Body / result |
| --- | --- | --- |
| GET | `/health` | `{status:"ok"}` |
| GET | `/downloads/install-worker.sh` | public POSIX installer script |
| GET | `/downloads/worker.tgz` | public configured Worker npm package |
| POST | `/bootstrap` | `{}` → stable default user, team, project; idempotent |
| POST | `/enrollment-tokens` | `{ttlSeconds?:3600}` (1–86400) → `{token,expiresAt}` |
| POST | `/workers/enroll` | `{token,name}` → `{workerId,worker,credential}` |
| GET | `/workers` | `{items: Worker[]}` |
| GET | `/workers/:id` | Worker |
| GET | `/workers/:id/capabilities` | `{workerId,capabilities}` |
| POST | `/projects` | `{name}` → Project |
| POST | `/workspaces` | `{projectId,workerId,name,repository:{gitUrl,revision?,name?}}` → `{workspace,commandId}` |
| POST | `/sessions` | `{workspaceId,title,agentKey,modelId}` → `{session,commandId}` |
| GET | `/projects`, `/workspaces`, `/sessions` | `{items:[...]}`; optional `projectId` / `workspaceId` filters |
| GET | `/projects/:id`, `/workspaces/:id`, `/sessions/:id` | resource |
| PATCH | same resource paths | `{name}` for project/workspace, `{title}` for session; bindings immutable |
| DELETE | same resource paths | 204; project/session soft deletion, workspace asynchronous deletion |
| POST | `/sessions/:id/messages` | `{content,commandId?,messageId?}` → 202 `{commandId,messageId,status}` |
| GET | `/commands/:id` | durable command projection (`pending`, `accepted`, `rejected`) |
| GET | `/sessions/:id/events?fromSeq=1&limit=100` | `{events,nextSeq,freshness}`; inclusive fromSeq, limit 1–1000 |
| GET | `/sessions/:id/stream?fromSeq=1` | SSE; `Last-Event-ID` resumes after last sequence unless fromSeq supplied |

Enrollment tokens are one-use, expiring and atomically consumed with worker creation; only SHA-256 hashes of enrollment/worker credentials are persisted. Credentials are returned once. For retryable message submission, reuse `commandId` and identical content/messageId: same command is reused, conflicting payload returns 409. Without a messageId, commandId supplies a stable message identity. 202 means durably pending/previously acknowledged, **not execution completed**.

Repository workspaces only in this slice; no composite provisioning. Provisioning never includes local paths or credentials. Workspace must be `ready` before session creation/message submission. Session creation requires an available execution capability; custom model IDs are accepted. Offline message submission is durable when workspace remains ready. Workspace deletion requires no non-deleted sessions. Project/session deletion only hides metadata: it does not stop running turns, cancel pending commands, or delete worker files. No retention GC yet.

SSE emits `event: session.event`, `id: <seq>`, JSON JournalEvent; emits `event: freshness` without an ID, plus heartbeat comments. It replays persisted contiguous history then tails commit notifications. Slow clients are disconnected and must reconnect using Last-Event-ID. Use fetch streaming with an Authorization header (native browser EventSource cannot set it).

## Worker integration

Connect `ws://127.0.0.1:3001/worker/ws` with `Authorization: Bearer <credential>`. No credential query parameter. A second connection for the same worker is rejected with HTTP 409 until the old connection is cleaned up. Unauthorized upgrade returns 401.

Every frame is JSON text using **existing `@wemux/wire-protocol` v1** and carries `protocolVersion:1,messageId:<unique string>`:

1. Within 10 seconds send `{type:"hello",side:"worker",workerId,workerVersion,name,platform,architecture,...envelope}`. The credential must own workerId. Server replies with server hello, then pending commands in insertion order.
2. Send `{type:"capability",workerId,detectedAt,capabilities,...envelope}` using AgentCapability objects.
3. For each command, persist/deduplicate by commandId before `{type:"ack",receipt:{commandId,status:"accepted"},...envelope}`; rejection uses the protocol's CommandError. Unacked commands retry after approximately 5 seconds and replay after restart. Accepted means worker has durable responsibility, not that the operation finished. The delivery window is 100 pending commands.
4. Workspace provision completion: `{type:"event",scope:"workspace",report:{workspaceId,status:"ready",reason:null,location:null,occurredAt},...envelope}`. Worker-owned location observations may be included instead of null.
5. Session events: `{type:"event",scope:"session",event:{sessionId,seq,occurredAt,payload},...envelope}`. Worker is journal authority. Positive sequence numbers start at 1. Duplicates must have identical JSON; conflicting events reject the transaction and close the connection. Only contiguous events appear through HTTP/SSE.
6. Reconnect: send `{type:"sync",kind:"heads",complete:true,heads:[{sessionId,lastSeq}],...envelope}`. Server requests missing ranges with `{type:"sync",kind:"request",sessionId,fromSeq,limit,...envelope}`. Reply with `{type:"sync",kind:"batch",sessionId,throughSeq,hasMore,events,...envelope}`. `throughSeq` is the page's last covered sequence; when hasMore is false it asserts the worker journal head. Gaps are retained, never silently skipped; unavailable ranges use `sync/gap`. Heads for omitted sessions remain unverified (complete does not imply deletion).
7. Send protocol heartbeat at least every 30 seconds; server echoes nonce. 60 seconds without valid input marks worker offline. Freshness becomes offline on disconnect/restart. Live events without an authoritative matching head remain syncing until heads/batch verifies the end.

Worker writes are ownership-checked for command, session and workspace, including location observations. Malformed messages, wrong version, spoofed identity and conflicting data receive protocol error and close 1008. Max HTTP body/WS frame is 1 MiB. Production rate limits, full grant enforcement and credential rotation APIs are deliberately outside this slice. Worker execution adapters and the Web HTTP/SSE integration are implemented in their respective applications.

## Tests

`node:test` via tsx exercises real ephemeral HTTP/WS servers and file-backed SQLite: bootstrap/auth, atomic/replayed/expired enrollment, capabilities, provisioning readiness, online enqueue/ack/idempotency, offline restart delivery, sequence gap/replay/conflict handling, SSE replay/live streaming, CRUD, migration persistence, secret hashing, transaction rollback, revoked credential rejection and cross-worker writes.
