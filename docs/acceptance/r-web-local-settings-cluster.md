# R-web 本地设置与集群接入（部分完成）

2026-09-29：共用 Web 构建在同源 Worker-shaped HTTP fixture 的 `/local/settings` 和 `/local/cluster` 路由通过真实 Chromium 验收。Agent 可执行路径显式设置/恢复自动检测；连接器及本机凭据后端展示。接入集群须输入 Server 地址、先探测再确认已核对目标及证书，提供一次性口令；加入后暂停、重连、退出均调用本地 Worker API 并刷新 Worker `/api/local/status`，本地登出删除 Worker Cookie，不使用 Server `/api/auth`、`/api/projects` 或集群身份。失败时保留错误；一次性口令注册结果未知时，不自动重投。

```bash
npm run typecheck
npm test
npm run build --workspace @wemux/web
npm run pack:check --workspace @wemux/worker
node apps/e2e/local-session-browser.mjs
node apps/e2e/host-bootstrap-browser.mjs
```

首个只读切片验证：`npm run typecheck`、根 `npm test`（Server 824 pass/6 skip，其他 workspace 9 pass，Web 290 pass）、Web 构建、Worker `pack:check` 与两条 Chromium 脚本均通过。原始日志 `/tmp/rweb-settings-*.log`，脚本在 `apps/e2e/local-session-browser.mjs`，接口断言 `apps/web/tests/local-session-api.test.mjs`。

后续写操作切片（#27）：同一 Chromium 脚本走托管安装明确确认/完成状态、本地 MCP 新建/凭据写入不回显/删除；Worker HTTP 测试拒绝跨 scope、未知字段、无 CSRF、错误 revision 和不匹配凭据，GET 对公开环境值脱敏。`apps/worker/test/connector-mcp-storage.test.ts` 断言本地删除不触碰集群定义；`apps/worker/test/cluster-lifecycle.test.ts` 断言安装并发/失败无选择变更。`npm run typecheck`、根 `npm test`（Server 827 pass/6 skip，其他 workspace 9 pass，Web 290 pass）、Web 构建、Worker `pack:check`、`node apps/e2e/local-session-browser.mjs` 均通过；日志见 `/tmp/rweb27-final2-{type,test,browser}.log`、`/tmp/rweb27-final-pack.log`。**该 Chromium 链路的 Worker API 为 fixture，托管 Agent 安装和凭据使用只验证 HTTP/状态与安全边界，没有实际联网下载或 MCP 调用**。页面目前仅支持创建/编辑 stdio、streamable_http 的有限字段以及单字段 Secret；带已脱敏公开环境/请求头的定义禁用页面编辑以防覆写。真实 Worker 发布共享静态文件已在后续 #25 验证（见下文）；真实 Server 入退集群随后在 #29 验证（见下文）；内联 Worker 工作台不得删除。探测仅表示 Server 回应，不是服务器身份的独立验证；实际信任依赖部署者核对地址/证书与 HTTPS。R2 真实 systemd 用户管理器验收另行跟踪。

共享 Web 发布切片（#25）：`npm run build --workspace @wemux/web` 后 `npm run pack:check --workspace @wemux/worker` 将相同 Web dist 纳入 tgz，验证安装后的 `web/index.html` 与实际 JS asset，日志 `/tmp/rweb25-packcheck-final.log`。`node apps/e2e/worker-shared-web-browser.mjs` 启动**真实未加入 Server 的 Worker 进程**，在 Chromium 经 `/local/settings` 登录，访问 `/local/cluster`、`/local`、深链及 hashed asset；断言无 JS 报错、未授权正常 401、其他 HTTP 失败为零、index no-cache/asset max-age=3600，日志 `/tmp/rweb25-real-browser-final.log`。`apps/worker/test/local-control.test.ts` 验证 CSP、API 不被 HTML 覆盖、路径穿越/丢失 asset 不回退。根 `npm run typecheck`、根 `npm test`（Worker/Server 828 pass/6 skip，其他 workspace 9 pass，Web 290 pass）均通过，日志 `/tmp/rweb25-{types,root-tests-final}.log`。**此验收未覆盖真实 Server 注册/加入/退出或公网反向代理**；无 Web 包时 Worker 继续使用已有内联首页。

真实集群生命周期切片（#29）：`node --import tsx apps/e2e/worker-cluster-browser.mjs` 启动实际 Server 服务、真实 Worker CLI 进程和 Chromium。通过 Worker 的共享 Web `/local/cluster` 登录、探测 Server、人工确认地址与证书及一次性口令注册，Server `/api/workers` 确认在线；页面暂停后 Server 离线、重连后同一 Worker ID 再次在线、退出后 Server 状态为 `revoked`，Worker 本地注册状态清除，且加入前创建的确定性 Test Agent 本地 Session 在退出后仍可从本机 API 列出，回到 `/local` 仍可打开本地会话入口。原始断言输出 `/tmp/rweb29-real-cluster-final.log`，仅包含结果及无敏感值的 Server 能力密钥警告；未保存口令、Cookie、数据库或 Worker home。**该本地 HTTP 测试并不验证公网 HTTPS、证书身份核查或真实 systemd manager**；Web 的“核对证书”由操作者承担。
