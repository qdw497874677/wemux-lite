# M2 双宿主首批实施契约

状态：M1 收尾决策，作为 M2 W1 与 W2 首批实现基线。产品总设计见 [Worker 独立 Web 工作台](worker-web-workbench.md)。

## 1. 首批边界

首批交付不是完整 Worker 工作台，也不重写现有运行时。它建立两个真实宿主可继续演进的安全基础：

1. Worker 安装身份独立于集群注册身份。
2. 本机管理员只能由可信本机 CLI 初始化，不能由首个 Web 请求抢注。
3. `start` 在未注册集群时也能启动本地控制面；已注册时同时维持原集群连接。
4. 本地控制面默认只监听 loopback，并默认拒绝匿名访问受保护资源。
5. 先复用 Agent 检测和 Worker 本地状态；本地 Session 创建、目录授权、公网 HTTPS 和集群加入 UI 在后续 W2/W3 切片完成。

首批不得宣称已完成持续对话、公网部署或 Web 加入集群。

## 2. 身份模型

### LocalInstallationIdentity

安装级稳定身份，保存在 Worker 自身 SQLite 中：

- `installationId`：本机生成的随机稳定 ID。
- `name`：本地展示名。
- `createdAt`：创建时间。

它不因加入、退出或更换集群而变化，不作为 Server 的 Worker ID。

### WorkerIdentity

现有集群注册身份，包含 Server 地址、集群 Worker ID 和本地 credential 引用。它可以不存在。删除或失效不能删除安装身份、本地管理员或本地数据。

### LocalAdmin

首批只支持一个本机管理员：

- 由 `admin init` 在本机创建。
- 密码只保存带随机盐的 scrypt 派生值。
- 不接受 Enrollment Token、Worker Credential 或 Server 登录凭据代替本机密码。
- 已初始化后拒绝覆盖；密码轮换作为后续管理操作补充。

## 3. CLI 契约

```text
wemux-lite-worker admin init [--username NAME] [--password-file FILE] [--home DIR]
wemux-lite-worker start [--host 127.0.0.1] [--port 3002] [--home DIR]
```

`admin init` 优先从 `--password-file` 读取密码；自动化环境可使用 `WEMUX_LOCAL_ADMIN_PASSWORD`。命令行参数不直接接收密码，避免进入 shell 历史和进程列表。

`start` 行为：

- 有本机管理员：启动本地 HTTP 控制面。
- 没有集群身份：本地控制面继续独立运行。
- 有集群身份：在同一进程中启动原集群连接和本地控制面。
- 既没有本机管理员也没有集群身份：失败并提示先执行 `admin init`。
- 有集群身份但没有本机管理员：保持旧集群启动兼容性，本地 Web 不开放并输出提示。

默认监听 `127.0.0.1:3002`。非 loopback 监听必须是显式配置；首批尚未提供受信代理/公网 HTTPS 完整配置，因此文档不得推荐直接暴露到公网。

## 4. 首批 HTTP 契约

无框架，使用 `node:http`。

- `GET /`：最小登录/状态入口。
- `GET /api/local/bootstrap`：返回是否已初始化，不返回密钥和集群凭据。
- `POST /api/local/auth/session`：验证用户名和密码，签发短期 HttpOnly、SameSite=Strict Cookie，并返回 CSRF Token。
- `DELETE /api/local/auth/session`：要求登录和 CSRF，撤销当前会话。
- `GET /api/local/status`：要求登录，返回安装身份、集群绑定摘要、已缓存 Agent 能力和本地状态摘要。
- `POST /api/local/control/shutdown`：要求登录和 CSRF，请求当前 Worker 进程有序退出；与 SIGTERM 共用停止路径。

安全基线：

- 请求体和响应大小有界。
- Cookie 不包含密码、Worker Credential 或 Enrollment Token。
- 会话随机值只保存在内存；进程重启即撤销。
- 受保护写操作要求 CSRF Header。
- 校验 Host；带 Origin 的请求只接受同源。
- 登录有每来源失败节流。
- 所有错误使用通用认证信息，不暴露密码记录。

## 5. 共享模块边界

首批形成以下依赖方向：

```text
CLI / Local HTTP host / Cluster transport
                ↓
       Worker application services
                ↓
Agent adapters / runtime / WorkerStore / journal
```

本地 HTTP host 不直接读取 SQLite 私有实现，不复制 Agent 探测逻辑，不生成伪 Project、Workspace 或集群 Worker ID。后续本地会话 API 应通过应用服务调用同一 `WorkerRuntime` 和持久队列；不能另建第二套 Session Journal。

## 6. 首批验收

1. 干净 home 执行 `admin init` 后，无 Server 配置可运行 `start`。
2. 重启后安装 ID 和管理员记录保持不变。
3. 匿名请求不能读取 `/api/local/status`；正确登录可读取且响应不含密码哈希或集群 credential。
4. 错误密码不能创建会话；退出后原 Cookie 立即失效。
5. 默认监听 loopback；显式非 loopback 监听时给出安全警告。
6. 已注册 Worker 的原连接、能力上报和命令执行测试不回归。
7. npm 包仍只依赖必要运行依赖，不新增 Web 框架或认证中间件。

## 7. 后续切片与实施状态

- W2 已实现：允许目录管理、本地 Session 创建/列表/切换/删除、发送、停止、Journal REST/SSE、Agent 与模型选择 UI，并通过本地/集群会话隔离测试。队列列表与逐条取消、长历史分页和公网反向代理配置仍需后续完善。
- W3 已实现：Worker Web 内的 Server 探测、Enrollment、连接、重连、暂停、退出和服务端凭据撤销；注册口令只参与一次性交换，不落盘。完整验证结果见 [`docs/acceptance/m2-worker-local-workbench.md`](../acceptance/m2-worker-local-workbench.md)。
- M6 待实现：多人、本地角色体系和委派授权。
