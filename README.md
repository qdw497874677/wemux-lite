# Wemux Lite

Wemux Lite 是面向个人与团队、自托管的 **AI 集群工作台**。它统一管理异构环境中的 Agent 与工具执行资源，既接入用户已有的 Agent，也提供可选的平台 Runtime，以项目和任务组织持续会话，让人与 Agent 协作完成项目。

> **愿景：汇聚异构环境中的 Agent 与工具执行资源，让 AI 自主完成任务、持续推进项目，人只做关键决策。**

这里的集群资源是 Agent loop、工具进程、浏览器、代码执行、构建测试等消耗的 **CPU、内存及相关执行环境**；模型训练与推理算力是另一回事，不是本产品所指的执行集群。

“Lite”表示轻量部署与必要依赖，不表示功能残缺或降低可靠性。目标是完善可长期使用的产品，而不是 MVP。上述定位与下方核心方向描述产品目标，**不代表所有能力已经实现或验收**；当前基础见文末。

## 产品与建设方向

### 核心方向

- **利用远程空闲资源**：将任务派发到符合权限、能力与环境条件且有可用容量的远程机器上运行 Agent，统一管理执行过程和资源状态；这里的资源利用不是模型推理算力调度。
- **任务限定执行机器**：任务可设置候选机器范围，支持范围内符合条件的机器申领，也支持指定机器执行；分配新执行不等于迁移已有会话。
- **支持 loop-in 与 loop-out**：loop-in 使用 Worker 本机 Agent Runtime 运行完整 loop；loop-out 使用平台 Runtime 驱动 loop，通过受控工具接口调用 Worker 执行资源。平台 Runtime 的部署位置、实现选型与实施优先级仍待设计；这两种形态是产品目标，不代表均已实现。
- **以项目看板组织工作**：参考 Vibe Kanban 的任务工作形态，通过 `Project → Task → 多个 Session` 组织研究、实施与验证，看板呈现任务状态，任务下查看执行现场与成果。所有 Session 都有 Task 归属，协调对话和 Worker 本地对话使用相应专用或本地 Task；仍支持手工开启会话，不强制先打开看板。
- **自主推进与人工介入共存**：具备项目管理职责的 Agent 使用与用户相同的项目管理能力，按授权组织任务、安排执行、跟踪阻塞和汇总成果。手工开启会话、调整与接手始终可用，但不要求人逐步调度每次执行。
- **多用户团队共同使用**：团队成员和获授权的 Agent 在同一工作台管理任务、使用共享执行资源，围绕成果分工、反馈、交接与审查；共享机器不自动授予全部项目、会话、文件或凭据的访问权。
- **以成果而非运行次数衡量推进**：执行成功不自动等于任务完成，结果依据验收要求与配置的审查策略处理。自主执行不等于无限权限或无限重试，也不意味着每个计划和工具调用都必须人工审批。

产品特点是将资源管理、持续会话、项目管理与协作连接成同一条工作路径，而不是仅提供节点列表和多个聊天窗口。

### 文档入口

- [本轮产品方向确认与参考研究](docs/research/ai-cluster-workbench-product-alignment.md)（参考证据与方向确认；[需求基线及未决选择](docs/specs/ai-workbench-requirements-alignment.md)、[规格与票据](docs/specs/web-next-index.md)分别跟踪实施）
- [产品定位与边界](docs/product-direction.md)
- [当前 spec、ticket 与需求追溯](docs/specs/web-next-index.md)
- [领域术语](CONTEXT.md)

Workspace 是项目级逻辑环境，可以在多个 Worker 上拥有独立 Placement；Session 固定绑定执行位置。跨节点管理不等于自动同步文件或迁移会话。文档描述的目标能力与当前代码、已验收能力严格分开。

### 已确认的 Worker 独立工作台方向（待实施）

Worker 将支持独立安装、自身 Web/API 鉴权与显式公网 HTTPS 访问，不要求先加入集群。用户可从 Worker Web 主动加入 Server；加入不自动上传本地会话或发布目录。集群与独立工作台复用运行时和会话 Web 模块，详见 [设计与交付切片](docs/design/worker-web-workbench.md)。下方命令仍是当前集群使用方式，不代表已提供独立 Web 启动入口。

## 从旧名称迁移

项目已由 `wemux-mini` 更名为 `wemux-lite`，CLI 入口为 `wemux-lite-worker`、`wemux-lite-agent` 和 `wemux-lite-agent-mcp`。原有 Worker 升级后如需保留身份、会话和 Agent 选择，请通过 `--home` 显式指定旧数据目录；不要直接启动到新的默认目录。环境变量仍使用 `WEMUX_*`。

## 当前架构

以下描述现有 Server / Worker 执行路径，不代表平台自有 Runtime 与 loop-out 的目标架构已经落地。

```text
apps/web         React 展示与 API adapter；不包含领域或执行逻辑
     │ HTTP + SSE
apps/server      HTTP / application / Worker WS / SQLite 分层控制面
     │ WebSocket v1
apps/worker      CLI / application runtime / adapters / SQLite / workspace 分层执行面
     │
local Agent + Git workspace

packages/domain          共享领域值与事件
packages/server-domain   Server 权限、资源、凭证和投影
packages/wire-protocol   版本化 Server–Worker 协议
packages/web-contract    Web 展示契约
```

应用层只依赖 ports；SQLite、HTTP、WebSocket、Git 和 Agent 均位于外层 adapter。默认使用 Node 内置 `node:sqlite`，Worker 通信依赖 `ws`；不要求外部数据库或消息中间件。

## 要求

- Node `>=22.13.0`
- npm
- Git（创建 Repository Workspace 时需要）
- 真实 Agent（二选一或都安装）：Pi 的 `~/.pi/agent` 本地认证配置；或已认证的 `claude` CLI

## 启动开发环境

```bash
npm install
npm run build:packages

# 终端 1：Server，默认 http://127.0.0.1:3001；WEMUX_ADMIN_EMAILS 声明实例管理员（必填）
# 邮件三项是自举前置：没有它，连部署者自己都注不了册（WEMUX_MAIL_OUTBOX 把邮件写到本地目录，链接从 .eml 里取）
WEMUX_ADMIN_EMAILS='you@example.com' WEMUX_PUBLIC_URL='http://127.0.0.1:8002' \
  WEMUX_SMTP_FROM='Wemux <no-reply@example.com>' WEMUX_MAIL_OUTBOX=/tmp/wemux-mail \
  npm run dev:server

# 终端 2：Web，默认 http://127.0.0.1:8002，/api 代理到 Server（WEMUX_SERVER_ORIGIN 可改上游）
npm run dev:web
```

## 单端口部署（推荐）

先构建 Web，再直接由 Server 托管静态资源，一个端口同时提供控制台、API 和 Worker 数据面（即本机部署时浏览器和 Worker 用的是同一个地址）：

```bash
npm run build --workspace @wemux/web
WEMUX_ADMIN_EMAILS='you@example.com' WEMUX_PUBLIC_URL='http://<主机>:8010' \
  WEMUX_SMTP_FROM='Wemux <no-reply@example.com>' WEMUX_SMTP_URL='smtp://user:pass@smtp.example.com:587' \
  PORT=8010 HOST=0.0.0.0 npm run start --workspace @wemux/server
# 打开 http://<主机>:8010/ 即控制台；Worker 的 Server URL 也是 http://<主机>:8010
```

静态目录默认取 `apps/web/dist`，可用 `WEMUX_WEB_DIST` 覆盖；未配置或目录不存在时仅提供 API。SPA 回退只对带 `text/html` 的浏览器导航生效，API 客户端未命中路由仍返回 JSON 404；控制台的同源 `/api/*` 调用由 Server 直接兼容。

第一次打开 Web 时会看到落地页：填「账号或邮箱 + 密码」登录，没有账号时用邮箱注册（收到验证邮件并确认后即创建账号）。实例管理员由部署声明：`WEMUX_ADMIN_EMAILS` 里的邮箱一旦注册并验证，账号就自动获得实例管理权限；没有声明任何邮箱时实例不会启动（也不会让第一个公开注册者当管理员）。**部署者要能注册成管理员，必须先配好邮件投递**：`WEMUX_PUBLIC_URL`（拼邮件链接的公开地址）+ `WEMUX_SMTP_FROM`，再加 `WEMUX_SMTP_URL`（SMTP 连接串）或 `WEMUX_MAIL_OUTBOX=<目录>`（本机联调：把邮件写成 `.eml`）。缺配置时注册与找回会以 503 明确拒绝并在界面说明原因，不会静默当作成功。登录态是独立的 HttpOnly Cookie 会话（不属于 PAT），可在账号页看到设备会话列表并逐条撤销；CLI 或脚本调用管理接口用账号页签发的 PAT。忘了密码时在 Server 所在主机上运行 `node apps/server/dist/cli.js credentials reset-password --username <用户名>`（可选 `--database`、`--keep-tokens`），它只在本机可用、会撤销该账号全部登录会话并写审计。应用内更换连接时使用「连接设置」弹窗。Worker 注册流程：

```bash
# 用账号页签发的 PAT 请求一次性注册 Token
curl -sS -X POST http://127.0.0.1:3001/enrollment-tokens \
  -H 'Authorization: Bearer <PAT>' \
  -H 'Content-Type: application/json' -d '{}'

# 在待接入 Linux/macOS Worker 上执行一次完成校验→私有版本安装→注册→用户级服务启动
# 需要 curl、Node.js >=22.13、npm；Linux 需运行中的 systemd --user；macOS 需已登录用户的 launchd GUI domain
# Server URL 支持 HTTPS（公网推荐）或 HTTP（可信内网，如 http://192.168.1.10:3001）
curl --proto '=http,https' --proto-redir '=http,https' -fsSL \
  http://127.0.0.1:3001/downloads/install-worker.sh \
  | WEMUX_SERVER_URL='http://127.0.0.1:3001' \
    WEMUX_ENROLLMENT_TOKEN='TOKEN' \
    WEMUX_WORKER_NAME='Worker 01' sh
# Linux 检查：systemctl --user status wemux-lite-worker.service
# macOS 检查：launchctl print gui/$(id -u)/com.wemux.lite.worker
```

安装器默认在 `~/.local/share/wemux-lite-worker/releases/<sha256>/` 安装隔离的 Worker，身份保存在 `~/.wemux-lite/`，Linux 使用 `systemd --user`，macOS 使用登录用户的 `~/Library/LaunchAgents/com.wemux.lite.worker.plist`；`current` 指针在新服务启动失败时恢复旧版本。Linux 需要注销后仍持续在线时由机器管理员按安全策略执行 `loginctl enable-linger <用户名>`；macOS LaunchAgent 依赖图形用户登录，不承诺注销后保持在线。没有相应用户服务管理器时安装明确失败，不会假装已部署；仅用于手工前台调试可显式设 `WEMUX_INSTALL_MODE=global`，该模式仍需自己维护服务生命周期。包下载与同源 manifest 做 SHA-256/长度校验；HTTP 仅适用于可信内网，公网必须用 HTTPS；同源 checksum 不等于发布签名。服务管理器的进程活跃检查仅证明 Worker 进程启动，不证明已连通 Server，请同时在节点页确认在线。升级重复运行安装命令时沿用既有 Worker 身份，已注册的 home 不需再次提供 Token；旧注册 Token 不应重用。详见 [Linux Worker 安装和回滚验收](docs/acceptance/r2-linux-worker-installer.md)。

Worker 安装不会安装 Agent。可在 Worker 机器上运行 `wemux-lite-worker agent use pi --path /absolute/path/to/pi` 复用已有安装，或显式运行 `wemux-lite-worker agent install pi --yes` / `agent install claude --yes` 下载固定官方 npm 包到 Worker home（不做全局安装）。通过 `agent list` 查看路径及来源；更改后重启 Worker。安装的网络/上游代码信任边界、认证和其他选项见 [Worker 本地 Agent runtime 管理](apps/worker/README.md#本地-agent-runtime-管理)。

详细接口和边界：

- `apps/server/README.md`
- `apps/worker/README.md`
- `apps/web/README.md`
- `CONTEXT.md`

## 验证

```bash
npm run typecheck
npm run build
npm test
npm run pack:check --workspace @wemux/worker
```

`apps/e2e/full-stack.test.ts` 会启动真实 Server、执行真实 Worker `register/start` CLI、创建临时 Git 仓库、Project、Workspace、Session，发送消息并验证 Test Agent 的流式 Journal、同步新鲜度和 Worker 离线状态。

可选的真实 Pi 全栈测试会产生网络请求和模型费用，并验证 Worker 重启后的原生 Session resume：

```bash
WEMUX_REAL_AGENT_E2E=1 npm test
# 可选指定检测结果中的 provider-qualified 模型 ID
WEMUX_REAL_AGENT_E2E=1 WEMUX_REAL_PI_MODEL='provider::model' npm test

# 使用真实远程仓库（Worker 进程必须已有对应 Git/SSH 权限）
WEMUX_REAL_AGENT_E2E=1 \
WEMUX_E2E_GIT_URL='git@github.com:qdw497874677/testrepo.git' \
WEMUX_E2E_GIT_REVISION='master' \
npm test
```

Worker 默认把 Workspace 分配到 `~/.wemux-lite/workspaces/<sha256(workspaceId)>`，Agent Session 以该 Workspace 根目录为 `cwd`；同一 Workspace 在同一 Worker 上的 Placement 内，多个 Session 共享目录；不同 Worker 上的副本不自动同步。

## 集群阶段管理

Web 侧边栏新增「集群阶段」页，集中管理集群中所有阶段性对象：

- **Worker 阶段**：在线 / 离线 / 已撤销，支持撤销（断开连接并作废凭据，幂等）；
- **命令阶段**：`pending → accepted → succeeded/failed`，可取消尚未交付的 `pending` 命令（Worker 迟到的回执优先，已取消命令不重复交付）；
- **Workspace 物化阶段**：各 Placement 独立记录 `pending/provisioning → ready/failed`，重试需明确目标 Worker，不能以一个副本就绪代表全部就绪；
- **Session 阶段**：可删除异常会话。

对应 Server 接口：`GET /commands`（支持 `status`/`workerId` 筛选）、`DELETE /commands/:id`（取消）、`POST /workspaces/:id/reprovision`（重发）、`POST /workers/:id/revoke`（撤销）。

## 当前基础与验证边界

- 当前以部署声明的管理员接入为主（`WEMUX_ADMIN_EMAILS`）；不能宣称已完成多用户、团队资源授权与客户端凭证的完整闭环。
- 已有逻辑 Workspace 与 Placement 类型和相关实现；多节点生命周期与客户端一致性按对应 spec/ticket 核验，非空 Composite Workspace 不作为已交付能力。
- `test` Agent 提供确定性执行验证；Pi 与 Claude Code 有本机 CLI 执行适配，需对版本、认证与真实运行分别验收。Codex、OpenCode 不因可检测就被宣称可执行。
- Server 是缓存与控制面，Worker Journal 是会话历史权威。
- 平台可选 Runtime、loop-out 执行路径和自主项目推进是已确认的产品方向，不在此声明为已交付能力；异构资源统一管理不承诺自动同步文件、透明迁移会话或操作系统安全隔离。
- 当前缺口不是永久产品边界。准确交付状态以 [spec/ticket 索引](docs/specs/web-next-index.md)、各票验收记录与可复查证据为准；构建通过不等于浏览器或真实 Agent 验收通过。
