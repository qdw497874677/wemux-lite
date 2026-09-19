# Ticket 01 回归基线与验收记录

## 隔离真实浏览器验收（最终放行证据）

- 目标：证明现有 `Browser → Server :8004 → online Worker → deterministic TestAgent → Journal/SSE → Browser DOM` 创建到可见回复链路，不以 HTTP 202 或“正在处理”替代 Agent 回复。
- 前置：运行中 Server PID 164468（bootstrap token 只从 `/proc/164468/environ` 注入脚本，未打印）、Worker PID 162155、ready Workspace `7bd1c600-dfe0-4362-8d29-46a3843dc8a5`、Worker `2ebb523d-ed97-4f8b-a73b-70bd829dda48`、Agent/model `test/test`、Chromium 1243。
- 通过记录：2026-09-14T11:35:09Z 创建 Session `ffb3c1bf-0bd7-4f70-8824-f46429a3f557`，浏览器 Composer 发送 `Reply with exactly T01-OK-mu161t7v`；DOM 在约 2.6 秒内显示 TestAgent 契约回复 `Echo: Reply with exactly T01-OK-mu161t7v` 和“回复完成”，Session 空闲；最终 DELETE 返回 204。
- 证据：`/tmp/wemux-ticket01-browser-mu161t7v/evidence.json`、`/tmp/wemux-ticket01-browser-mu161t7v/reply.png`。隔离会话已清理。
- 一次失败记录：`/tmp/wemux-ticket01-browser-mu15xyzb/evidence.json` 与 `failure.png`。失败原因是脚本错误期待指令遵循模型返回裸 `T01-OK-*`；截图实际已显示 TestAgent 的 `Echo: <prompt>`、工具完成、回复完成和空闲状态。修正断言后重新创建隔离 Session 并通过；该失败 Session 亦 DELETE 204。

## 最后一轮 hardening 基线（已通过）

- 完整阅读 `/tmp/acp-delegate/del_mu15d5nf_0nt1.out` 与 `/tmp/acp-delegate/del_mu15d5ne_gdvl.out`，修复其全部 P2/冻结缺口；报告中的两个历史 typecheck 错误已在此前修复，本轮全量复验通过。未开始 Ticket 02、无 commit、未运行真实浏览器。
- `apps/server/src/application/notifications.ts` 逐 subscriber 捕获同步 throw/返回 Promise rejection；后续 listener 继续，已提交 API 不失败。可注入 `{key,error}` reporter，默认 console.error，reporter throw/rejection 也隔离。`notifications.test.ts` 验证 createWorkspace 持久化成功、后续订阅者读提交数据并开新事务、错误记录、session 通知及 unsubscribe/故障 reporter，共 3 项。
- `apps/server/src/storage/sqlite/store.ts` 每次事务独立 token/facade，全部 reader/writer 调用检查租约，finally 失效。消除内部 SQL 操作跨 await 暂停，防止校验后异步写穿越事务边界。`transaction-lifecycle.test.ts` 枚举全部 tx 方法，验证 commit/rollback 后及下一事务中旧方法均拒绝（包括事务内提前捕获 writer），下一事务数据不受污染；两种结束路径下派生异步任务可公共读取/开新事务，真正事务内仍 fail-fast，共 4 项。
- TaskSummary 增加必需 `linkCount: number`，非负整数、无关联为 0、详情与 links 长度一致，列表/看板无需逐卡片取详情。共享契约新增运行时摘要测试及缺字段编译负例，共 4 个运行时契约测试。
- 双端 production-side compile fixture：`apps/server/src/application/task-platform.contract.ts`、`apps/web/src/task-platform.contract.ts` 均从公共 `@wemux/web-contract/task-platform` 导入，不复制 DTO、不接 endpoint/UI。Web 补 `@wemux/web-contract: 0.1.0` workspace 依赖并刷新 package-lock；Server 已有依赖，两端 tsconfig 已覆盖 src，无需修改。两端 `tsc --listFilesOnly` 均列出 `packages/web-contract/dist/task-platform.d.ts` 与各自 fixture，完成 M1 双端类型形状冻结确认，不冒充功能交付。
- 最终 `npm run build`（含全部包、Server、Worker 打包、Web）exit 0；`npm test`：TS/Node **53 项，51 pass、2 skip、0 fail**，Web **25 pass、0 fail**；`npm run typecheck` 全 workspace exit 0。定向通知/生命周期/committed-reader/组合测试 13 pass。中间首次 build 发现测试枚举方法为 unknown，改用 `assert.ok(typeof method === 'function')` 正确收窄后重新全量通过，未压制类型错误。
- 日志：`/tmp/ticket01-hardening-{build,test,typecheck,targeted}.log`；双端文件列表：`/tmp/ticket01-hardening-{server,web}-files.log`。两项既有真实付费/网络 Agent opt-in 测试仍 skip，不算其付费网络场景通过；确定性 TestAgent 的真实浏览器创建到可见回复验收见上节，Ticket 01 已放行。

## Reviewer blocker 修复后的基线（历史，不用于本轮放行）

- 完整阅读 `/tmp/acp-delegate/del_mu150sbt_gzsl.out`；未开始 Ticket 02，无 commit。
- 时钟顺序回归先红：后续测试发现 `Date.now` 为 Proxy 而非原函数。现仅 mock 一次并用 currentTime 推进，finally 恢复；紧随其后的无文件写入测试验证原函数、时间推进及与系统时间一致，转绿。
- committed-reader 交错测试先红：事务暂停时外部 commands/resource/delivery 已返回。修复为 public reader 与事务共用 FIFO 屏障，tx reader 不等待屏障。`:memory:` 下 commit/rollback 两分支、回滚后重复 delivery 为空、credentials/cache 屏障、并发事务顺序、失败后继续、嵌套/public-read fail-fast 全部通过。现有 audit 独立连接回滚测试保留；没有新增 public audit API。
- M1 `packages/web-contract/src/task-platform.ts` 契约冻结；新增 3 个运行时契约测试与 TypeScript 负例，包根与 domain-safe 子路径共同确认，无 endpoint/UI。
- 最终 `npm run build:packages` exit 0；`npm test`：TS/Node 45 项，43 pass、2 skip、0 fail；Web 25 pass、0 fail；`npm run typecheck` 全 workspace exit 0。中途 typecheck 捕获 Proxy 泛型调用与测试 Timestamp 类型问题，已修复并重跑，未忽略错误。
- 日志：`/tmp/ticket01-blocker-build.log`、`/tmp/ticket01-blocker-test.log`、`/tmp/ticket01-blocker-typecheck.log`。两项既有真实 Agent opt-in 测试仍 skip，不算验收通过。真实浏览器项保持未勾，留主会话执行。

## 上一轮执行结果（历史，不能用于本轮放行）

- 改动前原样 `npm test`：TS/Node 35 项，33 pass、2 skip、0 fail；Web 25 pass、0 fail。
- 改动后一轮 `npm test` 曾失败：`bootstrap secret issues an expiring persisted admin session` 在 server.test.ts 的首次鉴权断言出现 `401 !== 200`。原测试 token TTL 25ms，HTTP 调度在并行负载下超过 TTL；单独运行通过。修复仅限测试：用 t.mock.method 控制 Date.now，先验证有效，再推进 35ms 验证失效，不改变生产 token 语义。
- 最终 `node --import tsx --test apps/server/src/test/transaction-composition.test.ts apps/server/src/test/storage.test.ts apps/server/src/test/server.test.ts`：10 pass，0 fail，0 skip。
- 最终 `npm test`：TS/Node 36 项，34 pass、2 skip、0 fail；Web 25 pass、0 fail。
- 最终 `npm run typecheck`：所有 workspace 脚本通过，exit 0。
- 两项既有真实 Agent 测试因显式 opt-in 条件未启用而 skip，不计为真实 Agent 验收通过。日志为本次执行环境 `/tmp/ticket01-baseline.log`、`/tmp/ticket01-targeted.log`、`/tmp/ticket01-final-test.log`、`/tmp/ticket01-typecheck.log`，本文件保留结论以免临时日志丢失。

## 保留安全网与迁移映射

本票不迁移 Web 源码，不删除或改写既有断言。以下目标只在后续模块实际抽出时原子迁移，禁止先删安全网。

| 当前测试/断言（apps/web/tests/） | 类型 | 后续目标 |
|---|---|---|
| conversation-ux：已发送/正在处理/完成三标签 | source-contract，读取 App.tsx | features/sessions 展示映射 + timeline 源码 |
| conversation-ux：禁止“已受理” | source-contract | timeline/Composer |
| conversation-ux：禁止“消息已提交，等待工作节点确认” | source-contract | timeline/Composer |
| conversation-ux：Textarea 不因 pending disabled | source-contract | Composer 源码，浏览器验证实际可编辑 |
| conversation-ux：发送禁用条件 !canSend 或 pending 或空白 draft | source-contract | Composer + 提交判定纯函数 |
| conversation-ux：e2e-message.mjs 无 Date.now/browser-repro/timeline-e2e/final-e2e/echo-check 标记 | 脚本 source-contract | 原脚本原位保留，不迁 features |
| navigation-hierarchy：Project→Workspace→Session 文案 | source-contract | sessions/navigation |
| navigation-hierarchy：按 item.workspaceId === workspace.id 归组 | source-contract | 分组纯函数 + 导航源码 |
| navigation-hierarchy：Worker 为“执行节点” | source-contract | 导航元数据 |
| navigation-hierarchy：workspace 分支 onCreate('session', workspace.id) | source-contract | 导航动作接口 |
| navigation-hierarchy：禁止 Project→Workspace→Worker→Session | source-contract | 导航源码 |
| navigation-hierarchy：defaultWorkspaceId 空串默认值 | source-contract，create-dialog.tsx | infrastructure 创建初始化接口 |
| navigation-hierarchy：按 defaultWorkspaceId 查找 Workspace | source-contract | 创建初始化接口 |
| navigation-hierarchy：预选 defaultWorkspace.workerId | source-contract | capabilities 选择接口 |
| navigation-hierarchy：预选 defaultWorkspace.id | source-contract | infrastructure 创建接口 |
| api.test.mjs：HTTP/错误/消息/Journal | 现有行为测试 | shared/api + sessions/journal；逐条保留 |
| connection-storage.test.mjs：配置存取/清理 | 现有行为测试 | features/connection |
| proxy.test.mjs：Vite /api 边界/剥前缀/SSE token 转 Bearer | 现有行为测试 | 保留代理行为，模块请求目标随迁移更新 |
| worker-enrollment.test.mjs：命令引用/协议约束/环境传密钥/下载失败不执行 | 现有行为测试 | infrastructure/enrollment |

没有 DOM 测试环境，没有 React hook 挂载测试；源码断言不能称 DOM 行为测试。未来 hook 的 controller/纯函数测试与浏览器挂载验证分开记录。

Server 既有 server.test.ts 保留真实 HTTP + SQLite + 伪 Worker WebSocket + SSE 闭环，覆盖入队幂等/回执/Journal 同步与分页；storage.test.ts 保留 rollback/跨 Worker 权限/状态投影；cluster-stages.test.ts 及 Worker 原测试原样保留。新增 transaction-composition.test.ts 使用真实文件 SQLite、独立只读观察连接与事务边界探针：组合 workspace→模拟 ready→session→enqueue（含 capability 生成和同命令重试）只开一次事务；内部不通知；公共入口 audit 故障回滚；外层失败回滚 Repository/Workspace/Session/commands/audit；提交前观察不到 audit，失败无 wakeup，成功公共 enqueue 才通知。模拟 ready 仅是 fixture，不绕过生产 provisioning。

## 真实浏览器验收：本轮未执行，阻塞

**不勾选 Ticket 的真实创建到可见回复验收。** 自动 Node 集成的伪 Worker 不是真实 Worker/Agent/浏览器。现有 scripts/e2e-message.mjs 会选择第一个可执行 Agent，且依赖已有 ready Workspace，不能作为隔离且固定 test Agent 的完整门禁；本轮不在共享服务上运行它。没有本轮隔离浏览器链路记录，不沿用历史截图冒充通过。

可复现前置与操作清单（由下一次授权验收执行）：

1. Node >=22.13、现有 npm 依赖及构建产物；独立临时根目录，独立 Server SQLite 和 Worker home，选择空闲端口，不复用共享数据库/Worker。`npm run build`；Server 使用 `WEMUX_DATABASE_PATH=<临时目录>/server.sqlite WEMUX_ADMIN_EMAILS=<部署者邮箱> HOST=127.0.0.1 PORT=<空闲端口> npm run dev:server`（原为引导令牌 `WEMUX_BOOTSTRAP_TOKEN`，已由部署声明模型取代，见 `docs/acceptance/account-identity-deployer-admin.md`），确认构建 Web 静态文件被服务。
2. 浏览器连接填写上述 origin/bootstrap secret；API POST /auth/session 获取 admin token，POST /bootstrap 初始化。带 Bearer admin token 创建 enrollment token；不要把 token 写入日志或 URL。创建隔离项目。
3. `WEMUX_WORKER_HOME=<临时目录>/worker WEMUX_ENROLLMENT_TOKEN=<一次性token> node apps/worker/dist/cli.js register --server <origin> --name ticket01-test`；同一 home 执行 `node apps/worker/dist/cli.js start`。等待在线及 capability 上报。确定选择 execution/available 的 **test Agent / test model**，缺失则停止验收，不回退随机 Pi/Claude。真实付费模型另需本机认证和用户授权，不上传 provider key。
4. 用浏览器创建空 Workspace，等待 pending→provisioning→ready，再显式选择 test/test 新建 Session；发送固定普通文本，观察可见回复、工具/进度标签、发送期间输入可编辑、排队、重连补传及无重复 echo。记录 URL、固定 Agent/model、资源 ID、Journal 完成事件、截图和检查结果。额外检查项目/工作区/会话层级与预选。
5. 可用已有外部 Playwright 安装和 Chromium（脚本支持 WEMUX_E2E_PLAYWRIGHT/WEMUX_E2E_CHROMIUM），不向仓库新增 DOM 或浏览器产品依赖。在修订现有脚本以固定资源与 Agent 前优先按上述清单人工操作；不能直接将该脚本“运行无异常”判为全链路通过。
6. finally 停止本次 Worker/Server/浏览器，销毁本次临时根目录；不删除共享数据。Workspace DELETE 当前不支持，不能依赖 API 清理假装完成。记录缺条件为 blocked/skipped，并保留验收未勾状态。

## 范围

本轮额外完成 committed-reader 隔离、时钟泄漏回归及 M1 共享契约冻结；无 Task 表、endpoint/UI。原前置实现：只做三项创建/入队的事务内组合缝与 capability 事务读取；公共方法仍返回原 DTO 并在提交后通知。ServerStoreTx 增加 resources/commands reader 能力，使原语读到同事务内新 Session；不为后续功能添加表或端点。不改 Worker/wire-protocol，不增第三方依赖（最后一轮仅补 Web 对已有 workspace 契约包的依赖），不引入 App Shell/Task 实现，不创建 git commit。
