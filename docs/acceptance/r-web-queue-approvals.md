# R-web 本地会话队列与审批切片

状态：2026-09-29，**部分完成**。本地 Worker Adapter 增加排队消息逐条取消及运行时审批批准/拒绝；视图只依据已验证 Journal 的 `queuedItems` / `pendingApprovals` 列表显示操作，UI 请求成功后仍等待 Journal 确认，不把 HTTP 202 当成已执行。操作继续使用 Worker 自身 Cookie、CSRF；禁用历史 gap、撤权和本地登录失效时的提交。集群 Surface 未改动。

真实 Chromium `apps/e2e/local-session-browser.mjs` 在同源 Worker-shaped host 测试本机登录、选模型、创建会话、发送两条消息、取消排队、拒绝审批、停止运行和刷新续读；追踪断言不访问 `/api/auth` 或 `/api/projects`，状态由 Journal 事件收敛而不是响应乐观删除。`apps/web/tests/local-session-api.test.mjs` 覆盖 Worker CSRF、路径和决策。`apps/worker/test/local-control.test.ts` 原有后端鉴权/CSRF/队列/审批路线测试仍需在根测试中复跑。

验证：

```bash
npm run typecheck
npm test
npm run build --workspace @wemux/web
npm run pack:check --workspace @wemux/worker
node apps/e2e/local-session-browser.mjs
node apps/e2e/host-bootstrap-browser.mjs
```

未验收：真实 Worker 发行物中的共享 Web 页面、真实 Worker SSE 跨断线/会话过期补页、历史超过一页时的操作、运行时命令与工具上下文细节、真实 Agent 的待审批工具调用。不能以 fixture 取代真实 Worker 的安全/端到端门禁；`docs/acceptance/r-web-session-slice.md` 和 `docs/design/r-web-slices.md` 的其余缺口保持开放。
