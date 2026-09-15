# @wemux/worker

Wemux Lite Worker MVP. Node **>=22.13** (`node:sqlite`); Node 24+ recommended.
All session control comes from the authenticated Server, not a local CLI.

## Install and run

Install the Worker directly from the Wemux Server on each Agent host (no public npm registry required):

```bash
curl -fsSL 'https://wemux.example.com/downloads/install-worker.sh' | \
  WEMUX_SERVER_URL='https://wemux.example.com' sh

WEMUX_ENROLLMENT_TOKEN='ONE_TIME_TOKEN' \
  wemux-lite-worker register --server https://wemux.example.com --name 'Worker 01'
wemux-lite-worker detect
wemux-lite-worker status
wemux-lite-worker start
```

For development from this monorepo:

```bash
npm install
npm run build:packages
npm run build --workspace @wemux/worker
node apps/worker/dist/cli.js --version
```

`register` is a one-time operation and must run as the same OS account that will
run `start`. Upgrades preserve the Worker home: install the new package and restart
the foreground process or its service supervisor. The Server-delivered installer downloads the Worker `.tgz` from `/downloads/worker.tgz`
and installs it with the local npm client; it does not resolve `@wemux/worker` itself
through a registry. The package currently has third-party runtime dependencies, so npm
still needs access to its configured registry to install those dependencies. Uninstalling
the npm package does not remove `~/.wemux-lite-mini`; back up or delete that directory separately.

Options: `--home DIR`, `--name NAME`, `--server URL`, `--token TOKEN`.
Environment equivalents: `WEMUX_WORKER_HOME`, `WEMUX_WORKER_NAME`,
`WEMUX_SERVER_URL`, `WEMUX_ENROLLMENT_TOKEN` (prefer this over shell-history tokens).
Default home: `~/.wemux-lite-mini`. `register` refuses to replace an existing identity.
The `wemux-lite-agent` and `wemux-lite-agent-mcp` executables are internal per-turn capability
bridges; operators normally use only `wemux-lite-worker`.
`status` prints durable local state, **not** a claim of live Server connectivity.
SIGINT/SIGTERM stops transport and active turns, drains writes, then closes SQLite.
A PID lock prevents two local runtimes from executing the same queue. An invalid
lock file requires manual inspection; stale dead-PID locks are removed on startup.

### 本地 Agent runtime 管理

Worker 的安装、注册、启动和检测均不安装 Agent。机器上没有 Agent 也可以让 Worker 上线；未安装或未认证的 Agent 显示为不可用。复用本机已有安装，或由操作员明确选择安装：

```bash
# 所有命令使用同一个 Worker home / OS 用户；默认 ~/.wemux-lite
wemux-lite-worker agent list --home ~/.wemux-lite
wemux-lite-worker agent use pi --path /absolute/path/to/pi --home ~/.wemux-lite
wemux-lite-worker agent use claude --path /absolute/path/to/claude --home ~/.wemux-lite

# 警告：访问官方 npm registry，下载包和依赖，可能运行上游安装脚本。
# 不传 --yes 只报错，不启动 npm，也不安装任何软件。
wemux-lite-worker agent install pi --yes --home ~/.wemux-lite
wemux-lite-worker agent install claude --yes --home ~/.wemux-lite
wemux-lite-worker agent status --home ~/.wemux-lite
```

- `claude` 是领域 Agent key `claude-code` 的别名。`use` 只接受绝对可执行文件路径，不接受命令字符串或附加参数；会执行该本地文件的 `--version` 验证，不会启动 npm。请仅选择可信文件。
- 托管安装白名单固定为 `@earendil-works/pi-coding-agent@0.85.1`、`@anthropic-ai/claude-code@2.1.34`，来源固定为 `https://registry.npmjs.org`；不接受用户指定的包、版本、URL 或 shell 命令。版本是明确固定值，不表示自动更新到最新版本。安装后校验包名称、版本、bin 入口及 `--version`。
- 每次安装使用 `<home>/agents/<key>/<version>-<随机后缀>/` 独立 npm prefix，显式禁止 global 模式。不会覆盖已有用户安装或旧托管目录。npm 最长 5 分钟，版本验证最长 10 秒；安装或验证失败保留原有选择并移除本次失败目录。成功重装后的旧目录保留，确认没有 Worker 使用后可手动清理。
- 选择保存到权限为 `0600` 的 `<home>/agents.json`，原子更新并使用短写锁。优先级：保存的路径 > `WEMUX_PI_COMMAND` / `WEMUX_CLAUDE_COMMAND` > PATH。缺失的已选路径不会静默回退到其他安装。
- `agent list` / `agent status` 显示新进程检测结果和 `local` / `managed` / `environment` / `PATH` 来源；顶层 `status` 显示保存的选择与缓存能力，不代表运行中 Worker 已切换。**正在运行的 Worker 必须重启才应用选择**，没有热刷新。
- 安装不等于完成 Agent 登录或配置模型；使用相同 OS 账户通过 Agent 自身完成认证。Codex、OpenCode 目前只支持本地路径复用和检测，不支持托管安装或执行。Windows 托管安装暂不支持，请使用 WSL；本地复用要求可直接执行的文件，不通过 shell 启动 `.cmd`。
- 这是本地操作员 CLI，不提供 Server/Web 远程安装或任意命令执行接口。上游安装脚本和所选 Agent 以当前 OS 用户权限运行，不构成沙箱。

### Server contract

Default enrollment: `POST /workers/enroll`, JSON
`{ token, name, workerVersion, platform, architecture }`; token also sent as Bearer.
Response: `{ workerId, credential }` (additional fields ignored).
Default WebSocket: `/worker/ws`, `Authorization: Bearer <credential>`.
Override endpoint paths with `--enrollment-path` / `--socket-path` if needed.
Paths must stay on the supplied Server origin. Plain HTTP/WS is accepted for trusted LAN deployments; use TLS for public or untrusted networks.
Enrollment does not auto-retry a consumed one-time token after an ambiguous network
failure; obtain a fresh token from the Server if registration cannot be recovered.

## Layers

- `src/cli.ts`, `src/config.ts`: config, composition, enrollment, process lifecycle.
- `src/application/runtime.ts`: command orchestration, per-session execution,
  recovery and journal delivery; depends on ports, never SQLite, ws or subprocesses.
- `src/application/ports/`: persistence, local state, provisioner, agent interfaces.
- `src/storage/sqlite-store.ts`: schema version 1 migration, SQLite adapter,
  serialized atomic command/queue/state/journal writes, committed-read isolation.
- `src/transport/`: bounded/validated v1 JSON, ws heartbeat/ping, capped exponential
  reconnect, HTTP enrollment. Journal is the offline outbox; no volatile retry queue.
- `src/workspaces/local-provisioner.ts`: Worker-allocated hashed paths, staged
  empty directory / git clone, idempotent completion marker, cancellable subprocess.
- `src/agents/`: detection and execution adapters; native-session handles never
  replace the standard journal.

SQLite stores identity metadata, workspaces/checkouts, sessions/native bindings,
commands/fingerprints/results, persistent FIFO items, turns, journal, capabilities.
The long-term credential is in a separate mode-0600 file, referenced by identity;
home is mode 0700. It is never printed by status, stored in SQLite or sent in URLs.
Use a dedicated OS account: this is **not** an agent sandbox or encrypted secret vault.
Do not call public Store readers inside a transaction callback; use transaction
ports. Their reads deliberately wait for the transaction boundary.

## Commands and protocol

Supports `workspace.provision`, `session.create`, `session.enqueue`,
`session.cancel-queued`, `turn.stop`. `workspace.delete` is explicitly rejected.
Empty directories use `{ kind: 'composite', memberWorkspaceIds: [] }` and no
repositories. Git uses a repository workspace with one matching checkout spec;
repository URL/revision are immutable after provisioning. Nonempty composites
are explicitly unsupported in this MVP. Paths are never accepted as input.
Git uses the Worker OS credentials; no private keys are sent by Server.

`test` / model `test` is the deterministic E2E agent. Pi and Claude Code are
real executable adapters:

- `pi`: runs the selected local Pi CLI through RPC (default `pi` on PATH).
  Detection exposes authenticated models from Pi's normal local configuration.
  Turns stream text/tool signals, persist Pi's native session file and resume it
  on later turns. Override with `agent use pi --path ...` or `WEMUX_PI_COMMAND`.
- `claude-code`: runs the `claude` CLI with bidirectional stream JSON. It passes
  `--model`, persists `session_id`, uses `--resume` later, maps partial text/tool
  events, and terminates the child on stop. Override the executable with
  `WEMUX_CLAUDE_COMMAND`; permission mode defaults to `bypassPermissions` and can
  be changed with `WEMUX_CLAUDE_PERMISSION_MODE`.
- Codex and OpenCode remain detection-only.

Workers therefore execute Agents with the Worker OS user's credentials and full
workspace access. Authentication stays local; Server does not receive provider
keys. Stop cancels only the active turn; remaining FIFO messages continue.
Repeated command IDs replay receipts; changed payloads are rejected. ACK follows
the durable commit, not agent completion. Restart marks active turns
`failed/interrupted`, then resumes only unclaimed messages. Unknown/removed agent
or model never silently falls back.

Connection sends hello, a complete capability snapshot and complete journal heads.
Events are committed before sending. Reconnect reports heads; Server requests
inclusive `fromSeq`, Worker replies with count/byte-bounded batches and `hasMore`.
Unavailable/non-contiguous ranges produce `gap`. Journal is retained indefinitely
in this MVP, so duplicate event delivery is safe using `(sessionId, seq)`.

## Service supervision

Run the Worker as a foreground process under systemd, launchd, Docker, or another
supervisor. A minimal systemd service (adjust the executable path for your npm
prefix) is:

```ini
[Unit]
Description=Wemux Lite Worker
After=network-online.target
Wants=network-online.target

[Service]
User=wemux
Environment=WEMUX_WORKER_HOME=/var/lib/wemux-lite-worker
ExecStart=/usr/local/bin/wemux-lite-worker start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Register once as the `wemux` service user before enabling the unit. Do not persist
the one-time enrollment token in the unit. The service account must own the Worker
home and have the required Git/SSH, Pi, Claude, and workspace permissions.

## Validation

```bash
npm run typecheck --workspace @wemux/worker
npm run test --workspace @wemux/worker
npm run pack:check --workspace @wemux/worker
npm run typecheck
npm test
```

`pack:check` cleans and rebuilds `dist`, creates a real `.tgz`, installs it into an
empty temporary global prefix, checks all three executable links, runs
`wemux-lite-worker --version`, and rejects generated JavaScript that imports unpublished
`@wemux/*` runtime packages.

`node:test` covers SQLite rollback/committed reads, restart recovery, FIFO,
idempotency, cancellation, stop, streaming/tools, allocated git paths, enrollment,
real ws authentication/heartbeat/reconnect/replay, malformed frame rejection,
Claude JSONL/native resume/process cancellation, and Pi authenticated-model detection.

The default test suite uses the deterministic Agent and fixtures. To run the paid,
networked full-stack Pi path through Server → Worker CLI → workspace → native Pi
session → Journal, including Worker restart and native-session resume:

```bash
WEMUX_REAL_AGENT_E2E=1 npm test
# Optional exact provider-qualified model, for example openai-codex::gpt-5.4:
WEMUX_REAL_AGENT_E2E=1 WEMUX_REAL_PI_MODEL='provider::model' npm test

# Optional real remote repository; the Worker process needs matching Git/SSH access.
WEMUX_REAL_AGENT_E2E=1 \
WEMUX_E2E_GIT_URL='git@github.com:qdw497874677/testrepo.git' \
WEMUX_E2E_GIT_REVISION='master' \
npm test
```

Worker home defaults to `~/.wemux-lite-mini`. Agent turns run with `cwd` set to
`~/.wemux-lite-mini/workspaces/<sha256(workspaceId)>` (or the same layout under
`--home` / `WEMUX_WORKER_HOME`). Sessions do not receive separate directories;
sessions bound to one Workspace intentionally share that Workspace checkout.
