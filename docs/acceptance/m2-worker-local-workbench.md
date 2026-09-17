# M2 Worker 本地工作台验收记录

日期：2026-09-16
状态：M2 W1/W2/W3 代码、自动化验证与本机 HTTP 冒烟完成；真实付费 Agent 与公网 HTTPS 代理冒烟未执行。

## 范围

- 独立安装身份、本机管理员初始化，以及无 Server 身份时启动本地控制面。
- 本机登录、Cookie、CSRF、Host/Origin 校验及登录节流。
- 允许目录的规范路径授权。
- 本地 Session 创建、列表、切换、删除、发送、停止与 Journal。
- Agent/模型选择、即时重检与 SSE 实时事件。
- Worker Web 主动探测、加入、连接、暂停和退出集群。
- 同进程双宿主下，本地 Session 与集群 Session 的授权、执行和同步隔离。
- Worker 注册、连接和退出复用 CLI 的端点排序、Tailscale 预检及可选 `nc` 隧道生命周期。

## 全量自动化结果

在仓库根目录执行：

```bash
npm run typecheck
npm test
npm run build
npm run pack:check --workspace @wemux/worker
node apps/e2e/src/e2e.mjs
node apps/e2e/src/real-agent-e2e.mjs
node apps/e2e/src/capability-e2e.mjs
node apps/e2e/src/task-board-e2e.mjs
node apps/e2e/src/task-board-live-e2e.mjs
node apps/e2e/src/tailscale-e2e.mjs
node apps/e2e/src/multi-endpoint-e2e.mjs
```

结果：

- 全仓 TypeScript 类型检查通过。
- 全仓测试通过：Server 5、Web 22、Worker 23 个测试文件，以及全部 packages 测试。
- 全量构建通过；Worker pack-check 通过并验证 tgz 可独立安装和启动。
- 7 个 E2E 脚本全部通过。
- `git diff --check` 通过。

新增或强化的自动化覆盖：

- 规范目录去重、无效目录拒绝、本地会话持久执行与删除。
- 集群命令不能操作本地会话，本地命令不能操作集群会话；集群同步不包含本地 Session ID、Workspace ID 或消息正文。
- 所有本地工作台及集群写接口要求 CSRF。
- 会话 CRUD、发送、停止、SSE 和页面控制元素。
- Server 探测、注册、连接、暂停、自助撤销及服务端凭据吊销。
- Agent 自定义路径的设置、删除和即时重检；删除后恢复为 PATH 候选且不留下隐式 override。
- 本地状态摘要只统计本地安装身份所属资源，不混入集群资源。

## 本机 HTTP 冒烟

使用构建产物在临时 home 启动 Worker Web，完成以下真实 HTTP 链路：

1. `GET /healthz` 返回 `200`。
2. `GET /` 返回 Worker 页面。
3. `POST /api/local/auth/session` 登录成功，并取得 HttpOnly Cookie 与 CSRF token。
4. `GET /api/local/status` 返回本地安装身份和未加入集群状态。
5. `POST /api/local/workbench/directories` 授权临时目录。
6. `POST /api/local/workbench/sessions` 创建本地会话。
7. `POST /api/local/workbench/sessions/:id/messages` 发送消息。
8. `GET /api/local/workbench/sessions/:id/journal` 观察到 `user.message`、`agent.lifecycle` 和 `assistant.message`，测试 Agent 回复为 `test-agent: 冒烟`。
9. `POST /api/local/workbench/sessions/:id/stop` 停止成功。
10. `DELETE /api/local/workbench/sessions/:id` 删除成功。

该冒烟证明 M2 的 Worker 本地 Web、SQLite 持久化、AgentRunner、Journal 和控制接口可由发布构建真实运行。

## 受信 HTTPS 反向代理

Worker Web 自身保持最小化的明文 HTTP 监听，不解析或信任 `Forwarded` / `X-Forwarded-*`。需要公网访问时：

1. Worker 仅监听 loopback，例如 `--host 127.0.0.1 --port 3002`。
2. 由同机受信反向代理终止 HTTPS，并转发至 `http://127.0.0.1:3002`。
3. 启动 Worker 时设置 `--secure-cookies` 或 `WEMUX_WORKER_SECURE_COOKIES=1`，会话 Cookie 将携带 `Secure; HttpOnly; SameSite=Strict`。
4. 反向代理必须保留原始 `Host`，不得把 Worker 后端暴露给不受信网络，也不得允许任意上游覆盖 Host。
5. SSE 路径 `/api/local/workbench/sessions/*/events` 必须禁用代理缓冲并使用长连接超时。

示例 Nginx 片段：

```nginx
location / {
  proxy_pass http://127.0.0.1:3002;
  proxy_set_header Host $host;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 1h;
}
```

不支持把明文 Worker Web 直接暴露到公网。应用故意不信任 forwarded headers，避免未配置可信代理列表时出现 Host、Origin 或 scheme 欺骗。

## 残余验证边界

以下内容不是 M2 自动化门禁的阻塞项，需具备外部环境后另行验证：

- 真实 Pi/Claude 登录态和付费模型对话；对应待办为 #140。
- 公网真实域名、证书和反向代理部署冒烟。
- 真实 Tailscale 网络中的 `nc` 数据通道；当前由 CLI 桩和 E2E 覆盖协议及生命周期。
- 更完整的长历史交互、本地会话搜索/重命名/归档和审批 UI，属于后续里程碑。
