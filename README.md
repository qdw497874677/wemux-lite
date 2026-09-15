# Wemux Lite

Wemux Lite 是面向开发团队的最小 Agent 执行控制面：Server 管理 Project、Worker、Workspace 和 Session；独立安装的 Worker 在本机执行 Agent，并把标准化 Journal 同步回 Server；Web 通过 HTTP + SSE 操作和观察会话。

## 从旧名称迁移

项目已由 `wemux-mini` 更名为 `wemux-lite`，CLI 入口为 `wemux-lite-worker`、`wemux-lite-agent` 和 `wemux-lite-agent-mcp`。原有 Worker 升级后如需保留身份、会话和 Agent 选择，请通过 `--home` 显式指定旧数据目录；不要直接启动到新的默认目录。环境变量仍使用 `WEMUX_*`。

## 架构

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

应用层只依赖 ports；SQLite、HTTP、WebSocket、Git 和 Agent 均位于外层 adapter。MVP 使用 Node 内置 `node:sqlite`，网络只额外依赖 `ws`。

## 要求

- Node `>=22.13.0`
- npm
- Git（创建 Repository Workspace 时需要）
- 真实 Agent（二选一或都安装）：Pi 的 `~/.pi/agent` 本地认证配置；或已认证的 `claude` CLI

## 启动开发环境

```bash
npm install
npm run build:packages

# 终端 1：Server，默认 http://127.0.0.1:3001
WEMUX_BOOTSTRAP_TOKEN='replace-with-a-long-random-secret' npm run dev:server

# 终端 2：Web，默认 http://127.0.0.1:8002，/api 代理到 Server（WEMUX_SERVER_ORIGIN 可改上游）
npm run dev:web
```

## 单端口部署（推荐）

先构建 Web，再直接由 Server 托管静态资源，一个端口同时提供控制台、API 和 Worker 数据面（即本机部署时浏览器和 Worker 用的是同一个地址）：

```bash
npm run build:web
WEMUX_BOOTSTRAP_TOKEN='replace-with-a-long-random-secret' PORT=8004 HOST=0.0.0.0 npm run start:server
# 打开 http://<主机>:8004/ 即控制台；Worker 的 Server URL 也是 http://<主机>:8004
```

静态目录默认取 `apps/web/dist`，可用 `WEMUX_WEB_DIST` 覆盖；未配置或目录不存在时仅提供 API。SPA 回退只对带 `text/html` 的浏览器导航生效，API 客户端未命中路由仍返回 JSON 404；控制台的同源 `/api/*` 调用由 Server 直接兼容。

第一次打开 Web 时会看到落地页：在右侧连接卡片粘贴启动 Server 时设的 `WEMUX_BOOTSTRAP_TOKEN`（即环境变量的值）并点击「连接并进入控制台」即可 - 首次连接会自动创建默认团队与项目，之后直接进入控制台；该令牌同时也是日常调用管理接口的凭证。应用内更换连接时使用「连接设置」弹窗。Worker 注册流程：

```bash
# 用管理 Token 请求一次性注册 Token
curl -sS -X POST http://127.0.0.1:3001/enrollment-tokens \
  -H 'Authorization: Bearer replace-with-a-long-random-secret' \
  -H 'Content-Type: application/json' -d '{}'

# 在待接入机器上执行一条命令完成 安装→注册→启动（目标机器需要 curl 和 Node.js/npm）
# Server URL 支持 HTTPS（公网推荐）或 HTTP（可信内网，如 http://192.168.1.10:3001）
curl --proto '=http,https' --proto-redir '=http,https' -fsSL \
  http://127.0.0.1:3001/downloads/install-worker.sh \
  | WEMUX_SERVER_URL='http://127.0.0.1:3001' \
    WEMUX_ENROLLMENT_TOKEN='TOKEN' \
    WEMUX_WORKER_NAME='Worker 01' sh
```

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

Worker 默认把 Workspace 分配到 `~/.wemux-lite/workspaces/<sha256(workspaceId)>`，Agent Session 以该 Workspace 根目录为 `cwd`；同一 Workspace 的多个 Session 共享目录。

## 集群阶段管理

Web 侧边栏新增「集群阶段」页，集中管理集群中所有阶段性对象：

- **Worker 阶段**：在线 / 离线 / 已撤销，支持撤销（断开连接并作废凭据，幂等）；
- **命令阶段**：`pending → accepted → succeeded/failed`，可取消尚未交付的 `pending` 命令（Worker 迟到的回执优先，已取消命令不重复交付）；
- **Workspace 阶段**：`pending/provisioning → ready/failed`，可对 `pending/failed` 的重新下发；
- **Session 阶段**：可删除异常会话。

对应 Server 接口：`GET /commands`（支持 `status`/`workerId` 筛选）、`DELETE /commands/:id`（取消）、`POST /workspaces/:id/reprovision`（重发）、`POST /workers/:id/revoke`（撤销）。

## MVP 边界

- 单 bootstrap 管理员；完整用户、团队授权 UI 尚未实现。
- Repository Workspace；Composite Workspace 尚未实现。
- `test` Agent 提供可重复的执行闭环。
- Pi 使用本机 CLI RPC，Claude Code 使用本机 CLI stream-json bridge；均支持原生会话续接、流式事件和停止。Codex、OpenCode 仍为检测模式。
- Server 是缓存与控制面，Worker Journal 是会话历史权威。
