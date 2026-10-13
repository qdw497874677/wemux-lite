# 协调附件两阶段上传：Server 收件与 Worker 投递验收（2026-10-11）

状态：**票 04 的两个上传验收项实现并通过同候选验证**（分支 `t04-attachments`，基线 `4eb0800` + `integration/web-next-coordination-closure` tip）。本记录只覆盖上传切片，不勾选票 04 其余验收项（Web 入口整体、断线重连、移动端等仍开放）。未运行付费 Runtime（真实 Pi 的附件读取不在本次授权内），Agent 读取由 Test Agent 的 `read-file` fixture 验证。

## 两阶段边界（显式区分，不以收件冒充交付）

- **阶段一（Server 收件）**：`POST /api/teams/:teamId/coordination/attachments`（multipart，文件 ≤ 1 MiB，含框架开销上限 1 MiB + 64 KiB）。单个事务内创建/复用团队协调 Task 与 Session（`requestId` 命名空间 `coordination-upload:`）、写入 `session-attachment` 记录、入队投递命令并挂依赖；字节先写入内容寻址 blob（失败不产生可见孤儿）。此阶段完成 ≠ 附件可供 Agent 使用。
- **阶段二（Worker 投递 + Agent 读取）**：新命令 `session.attachment.deliver`（内联 base64，sha256/size 校验）依赖 `session.create` 的 `commandId`，Worker 校验后写入 Workspace 的 `attachments/<sha256[0:12]>-<文件名>`。Agent 能力由 Worker 如实上报（`AgentCapability.attachments`），Test Agent 声明 `true` 并提供 `[test-agent:read-file] <相对路径>` fixture 实际读回原字节并回显 `sha256=`/`size=`。**Pi 未声明该能力（未验证），Web 上传控件对未声明能力的 Agent 保持关闭。**

投递状态由命令投影推导：pending=待投递（含 Worker 离线，UI 如实提示）、accepted=已投递、rejected/cancelled=失败（附原因）、Worker 撤销授权时 pending 投影为失败且新上传被拒。

## 同候选验证（退出码 0）

- `npm run build:packages` → 0（`/tmp/wemux-notes/attachments-build-packages.log`）。
- Worker：`TMPDIR=/var/tmp npm test --workspace @wemux/worker` → `519 pass / 0 fail / 4 skipped`，0（`attachments-worker-suite.log`）。新增 `apps/worker/test/session-attachment-delivery.test.ts`（投递校验、事务原子性、重启重放、read-file fixture）。
- Server：`TMPDIR=/var/tmp npm test --workspace @wemux/server` → `958 pass / 0 fail`，0（`attachments-server-suite.log`）。新增 `apps/server/src/test/team-coordination-attachments.test.ts`（首传原子绑定、幂等/冲突/重启重放、无能力 Agent 拒绝、非成员/查看者拒绝、撤权失效、413/400 边界、孤儿负例）。
- Web-next：`PLAYWRIGHT_CORE_PATH=… PLAYWRIGHT_CHROMIUM_PATH=… WEMUX_NEXT_TEST_DIST=/tmp/… scripts/test-with-browser.mjs -- node --experimental-strip-types --test apps/web-next/tests/*.test.mjs apps/web-next/src/components/__tests__/*.test.mjs` → `169 pass / 0 fail`，0（`attachments-webnext-suite.log`）。新增组件浏览器用例 `TeamCoordinationAttachments.test.mjs`：按声明能力开启控件、超限先拒、意外失败仅按原意图重试、两阶段文案与待投递/已投递/失败（含撤权原因）如实呈现、上传不虚构首条消息。
- 全仓 `npm run typecheck` → 0。
- 真实整链 `node --import tsx apps/e2e/team-coordination-attachments.mjs`（真实 Server + 入群 Worker + Test Agent）→ exit 0：离线时收件呈现待投递、同意图重放幂等与冲突 409、Worker 重启后按依赖顺序投递且落盘字节 sha256 一致、Agent read-file 回显 `sha256=01430560…`/`size=55`、撤权后在途投递失败且新上传 409、已投递事实不被改写（`/tmp/wemux-notes/team-coordination-attachments-e2e.json`）。

## 主要实现

- `packages/wire-protocol`：`WorkerCommand` 新增 `session.attachment.deliver`。
- `packages/domain`：`AgentCapability.attachments?: boolean`。
- `packages/server-domain`：`Session.creation` 扩展 `coordinationAttachment*` 字段。
- `apps/server`：`http/multipart.ts`（二进制安全解析）、`application/coordination-attachments.ts`（纯函数与状态推导）、`ServerService.createTeamCoordinationAttachment/coordinationAttachmentView`、team-routes 两条路由、store `session-attachment` 记录与 `getReceipt`、`handler.ts` 超限改为读完再 413（修复 RST 使客户端看到 ECONNRESET 的旧问题）、能力 ingest 校验 `attachments`。
- `apps/worker`：runtime 校验并原子写入附件（decode/sha256/size，越界路径由 `writeWorkspaceFile` 防护）、`tx.workspaces.get`（事务内读）、Test Agent `attachments: true` + read-file fixture。
- `packages/web-contract` / `packages/web-client`：`AgentDTO.attachments`；`postForm`、`uploadTeamCoordinationAttachment`、`coordinationAttachmentView`。
- `apps/web-next`：`TeamCoordination` 上传控件按 `agent.attachments === true` 开启，两阶段状态轮询呈现（待投递含离线提示、已投递、失败含原因、工作区内路径）。

## 未覆盖

- 真实 Pi 运行时的附件读取（未授权付费调用；Pi 未声明 attachments 能力，控件对其关闭）。
- 断线重连期间 Web 端长时轮询（60 秒上限后停止轮询，需刷新）、移动端浏览器专项、旧 `apps/web` 无上传入口。
- 超过 1 MiB 的附件、断点续传与多文件批量上传。
