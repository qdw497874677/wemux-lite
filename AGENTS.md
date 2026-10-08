# AGENTS.md — Wemux Lite 代理工作指南

面向在本仓库工作的 AI 编码代理（以及新成员）。产品定位见 `docs/product-direction.md`，领域术语见 `CONTEXT.md`，里程碑见 `docs/roadmap.md`；快速上手见 `README.md`。

## 项目是什么

Wemux Lite 是面向个人与团队、自托管的 AI Agent 集群管理与协作平台，不是 MVP。轻量约束作用于部署和不必要的依赖，不削减必要产品能力、测试与可靠性：**Server**（HTTP + WebSocket 控制面）集中管理注册上来的 **Worker**（执行节点），Worker 发现并上报本机 **Agent** 与模型清单；用户通过 **Web** 控制台从 **Project → Workspace → Session** 快速开始与任意 Worker 上的 Agent 对话；任务看板是可选的计划、指派与审查入口，使用 **Task → Run → Session** 执行追踪，不是自由对话的前置步骤。设计参照 `~/profiles/scribe/workspace/wemux-slim`（调研见 `docs/research/`）。旧任务规格 `docs/specs/0001-task-board-agent-platform.md` 只描述任务能力切片，不再定义整个产品定位；其历史限制不得覆盖当前产品方向。

已确认目标：Worker 可独立安装、无需注册集群即可使用自身鉴权的 Web/API，并支持显式公网 HTTPS；Web 提供主动加入集群、重试与退出。集群注册身份和 Web 用户凭据分离，不自动共享本地会话。运行时及会话 UI 按双宿主复用，设计见 `docs/design/worker-web-workbench.md`。此为待实施方向，勿把现有 CLI 当作已支持独立 Web；旧“全部远程会话必须经 Server”仅适用于集群控制路径。

## 已确认的新产品方向（实施基线）

当前优先事项见 `docs/specs/web-next-project-agent-platform.md`、ADR 0006/0007。前述旧的“无 Task 直接对话”描述已被取代：所有 Session 绑定 Task；Team 级协调 Task 用于讨论和交接，Project 内普通 Task 用于实施，Worker 独立宿主也需本地 Task。平台提供项目视角的内置 Agent API（创建任务、查询关联会话等），由 Runtime Adapter 通过适宜工具入口使用，不绑定 Pi 或 MCP。新前端在独立目录以 Paperclip 为基础，同实例 `/next/` 开发；迁移期旧版不要求持续回归，旧版历史异常不阻断新版票据；全部有效功能及双宿主、移动端验收后才删除旧版。上述是已确认目标，不代表代码已经实现。

## 仓库布局

```
apps/server    # @wemux/server：node:http + node:sqlite，无 Web 框架依赖
apps/worker    # @wemux/worker：Worker CLI，可 npm pack 成 tgz 分发
apps/web       # @wemux/web：React + Vite + TanStack Router/Query + Tailwind v4
apps/e2e       # 端到端验证脚本
packages/      # domain / server-domain / web-contract / wire-protocol（先构建这些）
docs/          # product-direction.md / roadmap.md / specs / design / research
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

环境变量（`apps/server/src/main.ts`）：`PORT`（默认 3001）、`HOST`（默认 127.0.0.1）、`WEMUX_ADMIN_EMAILS`（**必填**，逗号分隔的实例管理员邮箱；声明邮箱命中即管理员，缺失时 Server 拒绝启动）、`WEMUX_DATABASE_PATH`、`WEMUX_WEB_DIST`、`WEMUX_WORKER_PACKAGE_PATH`、`WEMUX_CAPABILITY_SECRET`。

邮件与 OAuth（`apps/server/src/server.ts` 读环境）：`WEMUX_SMTP_URL`（或 `WEMUX_MAIL_OUTBOX` 本地出件箱）+ `WEMUX_SMTP_FROM` + `WEMUX_PUBLIC_URL`（邮件链接只由它拼，不从请求头推）；`WEMUX_GOOGLE_CLIENT_ID`/`WEMUX_GOOGLE_CLIENT_SECRET`/`WEMUX_PUBLIC_URL`（半配置时分启动失败）。没有邮件投递时注册与找回明确不可用（503 + 界面说明），而部署者注册自己就是管理员的前提，所以自托管必须先配邮件。

手工联调环境（当前可用）：

```bash
# Server：绑定 0.0.0.0 供局域网/Tailscale 手机访问（自托管第一次启动必须能收验证邮件，否则自己注不了册）
PORT=8010 HOST=0.0.0.0 WEMUX_ADMIN_EMAILS='you@example.com' \
  WEMUX_DATABASE_PATH=/tmp/wemux-lite-manual-8010/server.sqlite \
  WEMUX_PUBLIC_URL='http://192.168.1.10:8010' WEMUX_SMTP_FROM='Wemux <no-reply@example.com>' \
  WEMUX_MAIL_OUTBOX=/tmp/wemux-lite-manual-8010/outbox \
  setsid nohup node apps/server/dist/main.js > /tmp/wemux-lite-manual-8010/server.log 2>&1 < /dev/null &
# 注册后验证链接在出件箱的 .eml 里（把邮件正文 base64 解码即可）；上生产换成 WEMUX_SMTP_URL
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
- Worker 列表 API 响应是 `{ items: [...] }`；账号接口分工（Ticket 04/05 之后）：管理员由部署声明 `WEMUX_ADMIN_EMAILS` 决定，没有引导令牌与首次认领接口；登录 `POST /api/auth/login`（JSON 体 `login`（兼容 `username`）/`password`，返回 `Set-Cookie`），管理员写操作带 Cookie + `x-csrf-token`，CSRF 明文由 `GET /api/auth/me` 一次性下发/轮换（安全读 GET 不需要 CSRF 头）。旧入口 `POST /api/auth/session` 已退役返回 410；`POST /api/auth/setup` 已删除。
- **Worker 有两种安装并存**：仓库构建（`node apps/worker/dist/cli.js start --home <home>`）与安装脚本装的全局包（`/opt/data/.npm-global/lib/node_modules/@wemux/worker`，命令 `wemux-lite-worker`）。两者可同时在线，节点名都是默认的“工作节点 01”，列表里会出现多个。判断哪个是你关心的节点：读 `<home>/worker.sqlite` 的 `documents(bucket='identity', id='worker')` 里的 `workerId`，再到 `GET /api/workers` 里比 `id`。
- Worker home 目录直接含 `credential` / `runtime.lock` / `transport.sqlite` / `worker.sqlite` / `workspaces/`（**没有** `identity/` 子目录）。
- **诊断“节点一直离线”先看它自己的队列**：`<home>/transport.sqlite` 里比较 `transport_meta` 的 `outbound_last_seq` 与 `outbound_ack:<outbound_epoch>`，并 `SELECT COUNT(*) FROM transport_outbox`。`SELECT seq,last_sent_at,payload_json FROM transport_outbox ORDER BY seq LIMIT 5` 的最老一行就是堵住重放的帧；`last_sent_at` 一直不推进 = 服务器拒绝后 worker 反复重发同一帧。
- **`artifacts/wemux-lite-worker.tgz`（`/downloads/worker.tgz`）只由 `npm run pack:worker`（或根 `npm run build`）刷新**，单独 `npm run build --workspace @wemux/worker` 不会更新它。让用户重装前先在 tgz 里 grep 验证修复已进包：`tar -xzf artifacts/wemux-lite-worker.tgz -C /tmp/x package/dist/transport/transport-store.js && grep -c <新符号> /tmp/x/package/dist/transport/transport-store.js`。
- 手工环境的节点清理：`POST /api/workers/:id/revoke` 只把 `connectionState` 置为 `revoked`（无硬删除接口），测试残留节点会一直留在列表里。
- 多会话并行改动时：server/worker 与 web 分属不同 workspace，但 `apps/web/**` 是共享文件；避免两个会话同时跑根 `npm run build`（会写共享的 `artifacts/` 与 `apps/web/dist`），优先 `npm run build:packages` + 单 workspace 构建。

## Web 端硬约束（回归测试锁定）

1. **禁止直接调用 `crypto.randomUUID()`**（`apps/web/src` 全目录）。经局域网/Tailscale IP 的 HTTP 访问是不安全上下文，该 API 不存在，点击会静默崩溃。统一用 `src/lib/random.ts` 的 `randomId()`。`tests/insecure-context.test.mjs` 会扫描源码强制执行。
2. **非安全上下文禁止用 execCommand 写剪贴板**。HTTP 访问时 `navigator.clipboard` 不存在，而现代 Chromium 对 `document.execCommand('copy')` 静默忽略却仍返回 true（假成功）。`src/lib/utils.ts` 的 `copyText()` 在非安全上下文直接返回 false；调用方需降级为 `selectElementText()` 全选 + 引导用户 Ctrl+C / 长按复制（同文件测试强制执行）。
2. **src 内本地值导入必须带 `.ts` 扩展名**（如 `from '../lib/random.ts'`）：web 测试用 `node --experimental-strip-types` 直接 import 源码，node ESM 不会自动补扩展名；tsconfig 已开 `allowImportingTsExtensions`。`import type` 不受影响（运行前会被剥离）。
3. 保留**源码契约**测试作为补充，但不能替代行为和真实浏览器验证。影响启动、路由、对话、权限、重连的交付必须做真实浏览器验收；可重复脚本纳入仓库，临时探针与原始证据放 `/tmp` 或 `.scratch`，脱敏验收摘要随规格保存。
4. 首屏是**落地页内联表单**（`src/components/landing.tsx`），不是弹窗；应用内重连才用 ConnectionDialog。`index.html` 内嵌脚本加载失败兜底横幅，勿删。
5. 静态服务：`index.html` 为 no-cache，assets 为 `max-age=3600`（带 hash 文件名）。

## 领域模型速记

- 组织：Team → Project；普通 Task 属于 Project，协调专用 Task 可直接属于 Team。Session 固定归属 Task，Workspace 生命周期独立，不随 Task 删除而清理文件。
- Workspace 是逻辑环境，Workspace Placement 是 `(workspaceId, workerId)` 的物理落点；不同节点的路径和状态独立，不隐式同步文件或迁移会话。
- 对话均绑定 Task，测试场景自动提供专用 Task；Session 固定 Task/Worker/Workspace/Agent，同 Session 模型切换对下一 Turn 生效，不修改当前执行快照。
- 普通 Task 状态机：`backlog | todo | in_progress | in_review | blocked | done | cancelled`；**Run 成功不得自动 done**，显式提交完成按配置审查策略处理；项目默认不强制审查，执行 Agent 不得自行取消要求。协调对话 active/waiting 不等于普通任务的完成/审查。
- 写操作带 `requestId` 幂等 + CAS 乐观并发；Run 取消有排队/启动/完成三态竞态处理；Session 可跨 Run 复用（reuse mode）。
- 术语严格按 `CONTEXT.md`（Worker/Agent/Project/Task/Task Workflow/Task Link 等，含 Avoid 列表）。写代码注释、测试、文档时遵守。

## 票据与证据

后续开发按 `docs/roadmap.md` 的里程碑推进，开工前拆成可独立验收的纵向切片。`.scratch/task-board-agent-platform/issues/01..08` 及证据是历史任务切片记录，不作为当前版本全量完成证明。改动要附可复查的日志、截图或断言输出；原始证据留在 `.scratch`，脱敏验收摘要与可重复测试纳入仓库。只在真实验证后勾选；明确区分已实现、已验证、部分完成和未开始。

## Worker 与 Agent 安装边界

- Worker 的生产依赖只包含通信等必要组件（当前为 `ws`），不得强制依赖或自动安装 Pi/Claude 等 Agent 运行时。必要依赖允许在 Worker 安装时由 npm 获取。
- Pi 使用本机 CLI RPC，Claude 使用本机 CLI；未安装或未认证应上报不可用，不能阻止 Worker 注册上线。
- 本机显式管理入口：`agent list`、`agent use pi --path /absolute/path/to/pi`、`agent install pi --yes`（也支持 `claude`）。所有命令支持 `--home DIR`，必须与运行中的 Worker 使用同一个 home。
- 托管 Agent 安装是独立联网操作，使用固定官方包版本，安装到 Worker home 内独立目录，不覆盖全局安装；变更路径后需要重启 Worker。Web 远程安装入口尚未实现。

## 其他约定

- Git 远端为 `git@github.com:qdw497874677/wemux-lite.git`，默认分支 `main`。提交前检查 diff，禁止提交 `data/`、`.scratch/`、凭据与本机构建产物。
- Node ≥ 22.13（本机 v26）；npm workspaces，无 pnpm/yarn。
- UI 中文文案；零 em-dash（—）装饰、无装饰性圆点；图标用 lucide；设计 token 沿用 Tailwind v4 + 现有 CSS 变量（深色优先，自动亮色）。
- 必要依赖与轻量部署是明确目标：保留 node:http/node:sqlite 默认方案，新增中间件需说明真实问题、替代方案与运维成本；不得以“最小化”为由省略安全、恢复、测试和完整生命周期。
- **Worker 在线状态只由拥有连接的进程重置**：`SqliteServerStore` 默认不重置持久化的 `worker`/`cache` 状态，只有 `createWemuxServer` 传 `presenceReset: true`。本机 CLI、验收脚本、备份等只读入口打开同一个数据库时不得把在线 Worker 刷成离线（历史缺陷：读取状态反而把连接中的 Worker 置为 offline）。
- **投递入队只允许有界事件触发**：握手/重连、新领域事件、应用层收据；纯传输 ACK 驱动的 flush 只能重放 outbox，不得重新入队，否则同一 Command 会在一条连接上形成 ACK→入队→发送的忙循环。收到收据即丢弃该领域身份的待发行，重投保持领域身份、只换 `directionSeq`（见 `docs/design/worker-reliable-connection.md` §9.2、§10.1）。
