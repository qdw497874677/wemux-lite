# R-web 宿主协商与路由隔离验收

2026-09-29，首个纵向切片，尚未迁移 Worker 本地会话 UI。Server 与 Worker 各公开不含登录/凭据的 `GET /api/host`，返回 `{ hostKind, contractVersion: 1, capabilities }`，`Cache-Control: no-store`。Web 使用同一构建产物，先校验 JSON、版本和宿主，再实例化 TanStack Router：集群只挂载集群路径，本地只挂载 `/local` 路径；本地 `/projects` 等路径显示本地不存在，不请求集群登录或数据。Worker 旧的 `/` 内联工作台及本地会话/API 保持原样；`/local` 的共享 UI 现在明确提示尚未启用，不能视为已迁移会话。后续切片见 `docs/design/r-web-slices.md`。

可重复验证（仓库根目录）：

```bash
npm run typecheck
npm test
npm run build --workspace @wemux/web
npm run pack:check --workspace @wemux/worker
node apps/e2e/host-bootstrap-browser.mjs
node apps/e2e/resource-preset-browser.mjs
node apps/e2e/skill-studio-browser.mjs
node apps/e2e/session-storage-browser.mjs
```

本次验证：类型检查、Web 构建、Worker 打包检查通过；根 `npm test` 通过，Server 824/830（6 skip）、其他 workspace 测试 9/9、Web 283/283；单独运行 Worker 本地控制测试为 11/12（1 skip）。真实 Chromium 脚本 `apps/e2e/host-bootstrap-browser.mjs` 通过：本地宿主直接打开 `/projects` 仅访问 `/api/host`，拒绝集群路由；`/local` 可进入未迁移提示；错误版本、网络 503 和重试恢复均无页面脚本错误。既有 Preset/Skill/Session 浏览器脚本通过。原始日志暂存 `/tmp/rweb-*`，不入库。

未验收：共享 Session Surface、Worker 内共享 Web 静态发布、实际 Worker 用户级 systemd 生命周期以及两宿主实际 Session 对话（见 R2 验收记录）。
