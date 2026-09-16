# AGENTS.md — Wemux Lite 代理工作指南

面向在本仓库工作的 AI 编码代理（以及新成员）。项目定位、领域术语见 `CONTEXT.md`；快速上手见 `README.md`。

## 项目是什么

Wemux Lite 是一个最小化的团队智能体协作控制台：**Server**（HTTP + WebSocket 控制面）集中管理注册上来的 **Worker**（执行节点），Worker 发现并上报本机 **Agent** 与模型清单；用户通过 **Web** 控制台从 **Project → Workspace → Session** 快速开始与任意 Worker 上的 Agent 对话；任务看板是可选的计划、指派与审查入口，使用 **Task → Run → Session** 执行追踪，不是自由对话的前置步骤。设计参照 `~/profiles/scribe/workspace/wemux-slim`（调研见 `docs/research/`）。当前形态已按任务看板型 Agent 协作平台规格演进，规格见 `docs/specs/0001-task-board-agent-platform.md`。

## 仓库布局

```
apps/server    # @wemux/server：node:http + node:sqlite，无 Web 框架依赖
apps/worker    # @wemux/worker：Worker CLI，可 npm pack 成 tgz 分发
apps/web       # @wemux/web：React + Vite + TanStack Router/Query + Tailwind v4
apps/e2e       # 端到端验证脚本
packages/      # domain / server-domain / web-contract / wire-protocol（先构建这些）
docs/          # specs（规格）/ design（交互与视觉系统）/ research（调研）
.scratch/task-board-agent-platform/   # 票据 + 验收证据（tickets 01–08）
```

## 常用命令

```bash
npm run build        # 全量：先 packages，再 server/worker，pack worker tgz，最后 web
npm run typecheck    # 所有 workspace
npm test             # server/worker/packages 测试（tsx + node:test）+ web 测试
npm test --workspace @wemux/web           # 仅 web（node --experimental-strip-types）
npm run pack:check --workspace @wemux/worker
```

改动 `packages/*` 后必须 `npm run build:packages`，下游按 tsc 产物类型检查。

## 运行与调试（重要）

环境变量（`apps/server/src/main.ts`）：`PORT`（默认 3001）、`HOST`（默认 127.0.0.1）、`WEMUX_BOOTSTRAP_TOKEN`（≥16 字符，管理员引导令牌）、`WEMUX_DATABASE_PATH`、`WEMUX_WEB_DIST`、`WEMUX_WORKER_PACKAGE_PATH`、`WEMUX_CAPABILITY_SECRET`。

手工联调环境（当前可用）：

```bash
# Server：绑定 0.0.0.0 供局域网/Tailscale 手机访问
PORT=8010 HOST=0.0.0.0 WEMUX_BOOTSTRAP_TOKEN='replace-with-a-long-random-secret' \
  WEMUX_DATABASE_PATH=/tmp/wemux-lite-manual-8010/server.sqlite \
  setsid nohup node apps/server/dist/main.js > /tmp/wemux-lite-manual-8010/server.log 2>&1 < /dev/null &
# Worker：先 register（--server --token）拿到凭据，之后 start --home
node apps/worker/dist/cli.js start --home /tmp/wemux-lite-manual-8010/worker
# Worker 多候选地址：`--servers`（或 WEMUX_SERVER_URLS，逗号分隔）连接失败自动轮换；
# `--prefer tailnet|direct|any`（或 WEMUX_PREFER）控制候选排序；单地址 `--server` 仍可用。
# 注册名持久化在 identity：start 时优先用它，避免 hostname 覆盖（改名需重新 register）
node apps/worker/dist/cli.js register --servers http://100.101.102.103:8010,http://192.168.1.10:8010 --token T --name my-worker
node apps/worker/dist/cli.js start --prefer tailnet  # 优先走 tailnet 地址，故障时轮换直连
# Worker 集成 Tailscale：register/start 自动预检（tailnet 地址才触发，普通地址零开销）；
# `tailscale [--server URL]` 子命令输出诊断报告（CLI 可用性/登录态/本机 tailnet IP/对端 ping）
node apps/worker/dist/cli.js tailscale --server http://100.101.102.103:8010
# Server 也有自检：GET /api/cluster/tailnet（管理员鉴权）→ 注册弹窗据此推荐 tailnet 地址
# 沙箱内无真实 tailscale；测试桩在 /tmp/fake-bin/tailscale，PATH=/tmp/fake-bin:$PATH 启动 server 即可验证
# 浏览器 E2E：playwright-core@1.61.0 恰好匹配沙箱已缓存的 chromium-1228，环境在 /tmp/wemux-tailnet-pw
```

沙箱陷阱（真实踩过）：

- **端口 8004 被僵尸进程占着，禁止使用**；测试一律动态分配端口或用 8010 手工环境。
- **不要用 `pgrep -f <模式>` 后直接 kill**：模式会匹配到执行命令的 shell 自身，把自己杀掉。用 `pidof node` + 读 `/proc/<pid>/cmdline` 过滤，或维护 pidfile。
- 后台服务要用 `setsid nohup ... & disown`（独立进程组），否则宿主清理任务会连带杀掉服务。
- 本沙箱里 **curl/ss 输出不可靠**：验证端口用 `node -e "fetch(...)..."`。
- Worker 列表 API 响应是 `{ items: [...] }`；管理员会话接口是 `POST /api/auth/session`，bootstrap 令牌放 `Authorization: Bearer` 头（不是 JSON body）。

## Web 端硬约束（回归测试锁定）

1. **禁止直接调用 `crypto.randomUUID()`**（`apps/web/src` 全目录）。经局域网/Tailscale IP 的 HTTP 访问是不安全上下文，该 API 不存在，点击会静默崩溃。统一用 `src/lib/random.ts` 的 `randomId()`。`tests/insecure-context.test.mjs` 会扫描源码强制执行。
2. **非安全上下文禁止用 execCommand 写剪贴板**。HTTP 访问时 `navigator.clipboard` 不存在，而现代 Chromium 对 `document.execCommand('copy')` 静默忽略却仍返回 true（假成功）。`src/lib/utils.ts` 的 `copyText()` 在非安全上下文直接返回 false；调用方需降级为 `selectElementText()` 全选 + 引导用户 Ctrl+C / 长按复制（同文件测试强制执行）。
2. **src 内本地值导入必须带 `.ts` 扩展名**（如 `from '../lib/random.ts'`）：web 测试用 `node --experimental-strip-types` 直接 import 源码，node ESM 不会自动补扩展名；tsconfig 已开 `allowImportingTsExtensions`。`import type` 不受影响（运行前会被剥离）。
3. 测试风格是**源码契约**：读源码文本做断言（见 `tests/landing.test.mjs`），不强制起浏览器；真实浏览器验证脚本放 `/tmp` 或 `.scratch`，产物存 `.scratch/task-board-agent-platform/evidence/`。
4. 首屏是**落地页内联表单**（`src/components/landing.tsx`），不是弹窗；应用内重连才用 ConnectionDialog。`index.html` 内嵌脚本加载失败兜底横幅，勿删。
5. 静态服务：`index.html` 为 no-cache，assets 为 `max-age=3600`（带 hash 文件名）。

## 领域模型速记

- 层级：Team → Project → Task → Workspace（绑定 Worker 的执行环境）→ Run（一次指派执行）→ Session（Agent 对话）。
- Task 状态机：`backlog | todo | in_progress | in_review | blocked | done | cancelled`；**Run 成功不得自动 done**，需人工审查（approve→done / changes_requested→blocked）。
- 写操作带 `requestId` 幂等 + CAS 乐观并发；Run 取消有排队/启动/完成三态竞态处理；Session 可跨 Run 复用（reuse mode）。
- 术语严格按 `CONTEXT.md`（Worker/Agent/Project/Task/Task Workflow/Task Link 等，含 Avoid 列表）。写代码注释、测试、文档时遵守。

## 票据与证据

功能开发按 `.scratch/task-board-agent-platform/issues/01..08` 垂直切片推进（01–07 已完成，08 发布验证部分完成：8 项勾选 2 项，证据在 `evidence/ticket-08/`）。改动要附可复查的运行证据（日志、截图、断言输出），写到对应 `evidence/ticket-XX/`，票据内的勾选框只在真实验证后勾。

## Worker 与 Agent 安装边界

- Worker 的生产依赖只包含通信等必要组件（当前为 `ws`），不得强制依赖或自动安装 Pi/Claude 等 Agent 运行时。必要依赖允许在 Worker 安装时由 npm 获取。
- Pi 使用本机 CLI RPC，Claude 使用本机 CLI；未安装或未认证应上报不可用，不能阻止 Worker 注册上线。
- 本机显式管理入口：`agent list`、`agent use pi --path /absolute/path/to/pi`、`agent install pi --yes`（也支持 `claude`）。所有命令支持 `--home DIR`，必须与运行中的 Worker 使用同一个 home。
- 托管 Agent 安装是独立联网操作，使用固定官方包版本，安装到 Worker home 内独立目录，不覆盖全局安装；变更路径后需要重启 Worker。Web 远程安装入口尚未实现。

## 其他约定

- Git 远端为 `git@github.com:qdw497874677/wemux-lite.git`，默认分支 `main`。提交前检查 diff，禁止提交 `data/`、`.scratch/`、凭据与本机构建产物。
- Node ≥ 22.13（本机 v26）；npm workspaces，无 pnpm/yarn。
- UI 中文文案；零 em-dash（—）装饰、无装饰性圆点；图标用 lucide；设计 token 沿用 Tailwind v4 + 现有 CSS 变量（深色优先，自动亮色）。
- 最小依赖是明确目标：Server 端坚持 node:http/node:sqlite 原生实现，新增任何中间件依赖前先质疑必要性。
