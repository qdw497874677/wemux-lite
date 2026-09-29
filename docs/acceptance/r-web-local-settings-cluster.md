# R-web 本地设置与集群接入（部分完成）

2026-09-29：共用 Web 构建在同源 Worker-shaped HTTP fixture 的 `/local/settings` 和 `/local/cluster` 路由通过真实 Chromium 验收。Agent 可执行路径显式设置/恢复自动检测；连接器及本机凭据后端**只读**展示。接入集群须输入 Server 地址、先探测再确认已核对目标及证书，提供一次性口令；加入后暂停、重连、退出均调用本地 Worker API 并刷新 Worker `/api/local/status`，本地登出删除 Worker Cookie，不使用 Server `/api/auth`、`/api/projects` 或集群身份。失败时保留错误；一次性口令注册结果未知时，不自动重投。

```bash
npm run typecheck
npm test
npm run build --workspace @wemux/web
npm run pack:check --workspace @wemux/worker
node apps/e2e/local-session-browser.mjs
node apps/e2e/host-bootstrap-browser.mjs
```

本次验证：`npm run typecheck`、根 `npm test`（Server 824 pass/6 skip，其他 workspace 9 pass，Web 290 pass）、Web 构建、Worker `pack:check` 与两条 Chromium 脚本均通过。原始日志 `/tmp/rweb-settings-*.log`，脚本在 `apps/e2e/local-session-browser.mjs`，接口断言 `apps/web/tests/local-session-api.test.mjs`。**未完成**：Agent 托管安装/进度、连接器编辑与 Secret 写入/脱敏页面，真实 Worker 发布静态文件及真实 Server 加入/断开/重连验收。现有本地连接器接口的保存端点接受未经完整 HTTP 边界验证的定义，迁移写操作前必须补严服务端输入校验及脱敏返回合同。内联 Worker 工作台不得删除。探测仅表示 Server 回应，不是服务器身份的独立验证；实际信任依赖部署者核对地址/证书与 HTTPS。R2 真实 systemd 用户管理器验收另行跟踪。
