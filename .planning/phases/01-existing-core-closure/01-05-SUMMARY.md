# 01-05 Workspace 个人隐藏：本地实现与待验门

状态：**部分完成，尚未签收**。这是 D-03/D-04 的个人隐藏增补，不是 01-04 历史 Task 删除的替代方案；后者仍保持 `task_has_sessions` 保护性拒绝。计划 frontmatter 的修改文件只是起点；新增账号级持久化需要扩展存储、迁移、客户端合同及真实浏览器脚本。

## 已实现

- 独立账号/Workspace 表与尾部迁移；`GET /api/workspaces` 支持默认 `visible`、`hidden`、单事务 `all`；列表逐项目实时授权、投影最新 Worker/Placement 状态，带 `visibilityHidden`、独立数字 `visibilityRevision`。原 Workspace 对象、文件、任务绑定、准备命令与历史证明未被隐藏操作修改。
- `PUT /api/workspaces/:workspaceId/visibility` 按当前 Project 权限校验，在一笔事务内执行 requestId 幂等、版本 CAS 和个人状态写入；撤权后旧请求重放不能绕过授权。原 DELETE、准备取消保护保持独立。`apps/web-next/src/components/ProjectWorkspaces.tsx` 提供“当前工作区”与“已隐藏（仅对你）”、隐藏和主动恢复；会话/任务资源选择器用 `all`，避免个人列表隐藏误作资源撤权。
- 源码范围：`apps/server/src/application/server-service.ts`、`apps/server/src/application/ports/server-store-types.ts`、`apps/server/src/application/create-request.ts`、`apps/server/src/storage/sqlite/{store,migrations}.ts`、`apps/server/src/http/routes/workspace-routes.ts`、`packages/web-contract/src/browser-host.ts`、`packages/web-client/src/project-management.ts`、`apps/web-next/src/components/{ProjectWorkspaces,ProjectConversation,TaskSessions,TaskDetailPanel}.tsx`，以及相应回归测试/验收合同。共享工作树其他未提交变更不归于此切片。

## 本地取证（2026-10-06）

- `apps/server/src/test/workspace-visibility.test.ts`：账号隔离、viewer/撤权、重放、CAS/ABA、旧库迁移、持久化、事务失败回滚、共享浏览器客户端真实 HTTP；最终定向组合 `/tmp/wemux-phase1-visibility-final-focused.log` **9/9**，Server 之前全套 `/tmp/wemux-phase1-visibility-server-suite.log` **913/913**（新增回滚测试后应在最终候选重跑全套）。Server 类型检查 `/tmp/wemux-phase1-visibility-final-server-typecheck.log` 通过；Next 构建 `/tmp/wemux-phase1-visibility-next-build.log` 通过；准备测试 `/tmp/wemux-phase1-visibility-web-test-browser.log` **166/166**。
- 当前源码私有 Vite 构建 `/tmp/wemux-phase1-visibility-next-private`；`apps/web-next/tests/real-worker-workspaces.browser.mts` 执行结果 `/tmp/wemux-real-workspaces-IuA3Ym/evidence/result.json` **passed=true**。桌面 1440×900、手机 390×844：两独立真实 WorkerRuntime/transport/home、真实本地 Git clone 与文件，UI 隐藏/恢复、版本 0→1→2、隐藏期间第二 Worker 断线重连和报告 ACK、双侧文件及物理落点不变、保护性准备取消和 DELETE；无 Agent 执行。证据目录还有两种视口的截图。最初使用 Playwright 目录而非 `index.mjs` 导致 setup 失败，修正浏览器入口后完整通过；失败不是产品缺陷。
- `WEMUX_VISIBILITY_ONLY=1` 跑 `apps/web-next/tests/project-management.browser.mts` 结果 `/tmp/wemux-phase1-visibility-two-account-browser.json` **passed=true，60 条检查**；双视口 Owner/Member/Outsider 分离的真实浏览器 Cookie、隐藏与手动恢复/刷新、撤权后不可列/不可恢复、复权后恢复，截图 `/tmp/wemux-phase1-visibility-two-account-browser.json.visibility-two-account-{desktop,mobile}.png`。此脚本采用受控 Worker 协议报告，不是两个真实 Worker；完整非聚焦脚本曾在后续旧 Session fixture 创建失败，不能借用聚焦 PASS 宣称原 Ticket03 整体完成。
- 独立只读复核未发现直接越权、CAS 绕过或半提交；指出的双列表跨快照风险已改为 `all` 单事务分组，旧库升级和行/收据共同回滚已补测；写入后刷新失败的 UI 提示现在明确“请求已提交，列表刷新失败须重试”，仍应最终候选人工核验体验。

## 尚未完成的验收

- 双获权账号及撤权账号的桌面/手机浏览器旅程与双真实 Worker/物理文件旅程已分别通过，但尚不是**同一个运行候选内**双账号+双 Worker 的组合执行。真实跨物理机器部署、Agent/模型也不由这些脚本证明。
- 需要同一候选重跑 Server 全套、Next 准备测试、双账号/双 Worker 组合及独立复审；随后才可将 01-05 标为已验收。票 03 的历史 Task 安全删除第六条仍未证明，阶段 1 和票 03 均保持 OPEN。验收详情参见 `docs/acceptance/web-next-project-workspace-task-management.md`。
