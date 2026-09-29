# R-web 本地会话首条路径验收

状态：2026-09-29，**部分完成**，仅源码级共享 Web 在 Worker-shaped HTTP fixture 上验证；Worker 真实 tgz 尚未发布这一份 Web 构建，不能宣称本地用户已可从现有 Worker 打开 `/local`。`/` 的内联工作台继续可用且不得提前删除。集群 Web 的原 Session Surface 不变。

本切片将 `useSession` 的依赖缩为 Journal Interface（`events` + `watch`）；Worker Adapter 复用已有本地 HTTP Journal 正向分页、事件 SSE 和本机 Cookie，不借用 Server 身份、Team、Project 或虚构的集群 Worker ID。共享时间线的 `projectJournal`、`TimelineEntry` 在 `/local/sessions/:id` 上消费该 Adapter；本地登录、目录授权、Agent/模型选择、建会话、发送、停止与刷新历史可用。发送响应未知时同一内容重试复用请求标识；历史 gap 不能显示为 synced。设置和接入路由暂显示迁移提示，需继续实现。

验证：

```bash
npm run typecheck
npm test
npm run build --workspace @wemux/web
npm run pack:check --workspace @wemux/worker
node apps/e2e/host-bootstrap-browser.mjs
node apps/e2e/local-session-browser.mjs
node apps/e2e/resource-preset-browser.mjs
```

本次执行：类型检查通过；根 `npm test` Server 824 pass/6 skip、其他 workspace 9 pass、Web 289 pass；Web 构建通过；Worker pack:check 通过。真实 Chromium `local-session-browser.mjs` 用同源 Worker-shaped host 测试本机登录 → 选 Agent/模型建会话 → Journal 显示发送 → 停止 → 刷新续读，且没有集群 `/api/auth` 或 `/api/projects` 请求。`host-bootstrap-browser.mjs` 测试本地禁止的集群路由只访问宿主发现。原始日志在 `/tmp/rweb-local-*`、`/tmp/rweb-session-*`。

**未通过的发布门禁**：真实 Worker 本地 Web 静态发布与包内离线首次打开、跨刷新/断线真实 Worker SSE、旧记录操作、消息排队与审批、实际模型 Turn；不得用此 fixture 替代集成验收。R2 的真实 `systemd --user` manager 仍受环境限制，单独跟踪。
