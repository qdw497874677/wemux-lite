# Team 协调聊天：真实浏览器受控验收（部分）

候选：`integration/web-next-coordination-closure`，功能合并 `b2220fa`，浏览器 E2E 脚本 `b422373` 及后续显式重开验证。**NEXT-05 与协调 spec 的 03/04 票均未整票验收**。历史阶段 2 隔离门 FAIL 的文档只记录当时状态；现在依据 [ADR 0008](../adr/0008-coordination-chat-ordinary-runtime-permissions.md) 用普通 Agent 权限提供协调聊天，不宣称 OS 文件/网络隔离。

## 本次可复查的通过项

- `npm run build:packages`，Server/Worker/Web-next `typecheck`：退出码 0。
- `apps/e2e/team-coordination-transport.mjs`：真实 Server、注册 Worker、签名 WS 首发、Test Agent 回显与完成、首发幂等、后续发送、同 home Worker 重启后历史恢复及非成员拒绝，共 4 组通过。
- `apps/e2e/team-coordination-first-send.mjs`：同类独立 Worker 首发/重复提交/继续发送，5 组通过。
- `apps/e2e/team-coordination-real-browser.mjs`：同一次候选构建 `/next/`，真实 Server/Worker/Test Agent + Chromium 桌面 1440×1000 与手机 390×844：登录 Team 页、选择已就绪的 Project Workspace/Worker/Agent、首发、等待消息回显与 Turn 完成、刷新后按 Session ID 恢复原历史，并显式在原协调 Task 下重开新 Session、再次完成对话、核对原 Task ID 与原历史；新增加非成员账号真实 HTTP 的 availability/history/first-send 及已知 Session/Journal 读写拒绝（资源响应为 403 或 404，不泄露消息）、Worker 断线时 Team 页移除不可用环境且历史可读、同 home 重连后再次完成对话；Team 页原生审批批准与拒绝均真实进入 Test Agent、指定运行 Turn 停止、注入失败在 Journal 可见并用浏览器会话消息编辑器再次发送成功。合计 **14 组通过**，页面异常 0。失败日志只输出步骤、错误类型及异常计数，不打印浏览器错误消息或凭据。两视口各自创建自己的 Session；没有把一台手机与桌面共享同一浏览器登录状态当成跨设备同步验收。
- `apps/web-next/src/components/__tests__/TeamCoordination.test.mjs`：Playwright 浏览器组件测试通过，另覆盖旧模型消失后选择同一 Agent 当前模型及首发结果不确定时冻结编辑/刷新，按原请求重试；Worker 原始 Node 报告 509 pass/5 skip/0 fail；Web-next prepared 测试 168 pass/0 fail。Server 全套串行执行超过 300 秒而中止，不能记为全绿；定向 Team 功能测试已通过。

复现命令（SQLite WAL 与 Chromium profile 放磁盘；静态构建只拷贝到 `/tmp`，不在 `/tmp` 建数据库）：

```bash
npm run build:packages
npm run typecheck --workspace @wemux/server
npm run typecheck --workspace @wemux/worker
npm run typecheck --workspace @wemux/web-next
npm run build --workspace @wemux/web-next
mkdir -p /home/qdw/.cache/wemux-test-tmp
DIST=$(mktemp -d /tmp/wemux-next-browser-dist-XXXXXX)
cp -a apps/web-next/dist/. "$DIST/"
TMPDIR=/home/qdw/.cache/wemux-test-tmp node --import tsx apps/e2e/team-coordination-transport.mjs
TMPDIR=/home/qdw/.cache/wemux-test-tmp node --import tsx apps/e2e/team-coordination-first-send.mjs
WEMUX_NEXT_TEST_DIST="$DIST" TMPDIR=/home/qdw/.cache/wemux-test-tmp \
  PLAYWRIGHT_CORE_PATH=/home/qdw/.cache/wemux-pw/node_modules/playwright-core/index.mjs \
  PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium \
  node --import tsx apps/e2e/team-coordination-real-browser.mjs
```

上述 Playwright 依赖路径为本机临时安装，运行时可换为等价环境变量；浏览器脚本只使用非付费 Test Agent，所有数据库/Worker home 由测试创建并在关闭后清理。浏览器测试没有付费调用、外部投递或删除用户数据；另见下方真实 Pi 验收。

## 真实 Pi Runtime 补充验收

用户明确允许付费测试后，在本机已认证 Pi CLI 1.0.4 上运行 `apps/e2e/team-coordination-paid-pi.mjs`：`WEMUX_REAL_PAID_PI_E2E=1`、`WEMUX_REAL_PI_EXECUTABLE=$(command -v pi)`、`WEMUX_REAL_PI_MODEL=zai-coding-cn::glm-5.3-flash`、磁盘 `TMPDIR`。退出码 **0**，报告 `paidTurns: 1`：真实 Server、注册 Worker、就绪 Workspace、真实 Pi 模型能力 → Team 协调首发自动绑定 Task/Session → Journal `turn.finished: completed` 且回复包含预设标记。预检 `pi auth check --no-refresh` 不输出凭据；脚本最多提交一次请求，不对未知结果重试。只使用临时 Server/Worker 数据，未清理用户数据。此为外部付费模型真实链路，而非本地假模型；不记录令牌、响应正文或费用数值，未获得计费平台的精确扣费收据。

此首发证据证明 **一个 Pi 模型的一次普通协调对话**。用户随后明确允许以现有 Pi `5.3-flash` 继续实际验收；`apps/e2e/team-coordination-paid-pi-tools.mjs` 用新的临时 Server/Worker/Workspace/Team Session 做文件工具纵向测试。首次尝试提交 **1 个付费 Turn** 后在首发验证断言失败，未保留原始模型输出，也未自动重试未知结果；另起独立环境第二次运行提交 **2 个付费 Turn** 并退出码 **0**：Pi 在自有 Workspace 创建带随机标记的文件，宿主读取验证内容，Journal 有 `tool.started`/`tool.finished`；旧版断言曾报告同一 Session 下一 Turn 使用工具读取文件并返回标记，但独立审查发现其工具/回复证据未限定在第二个 Turn，不能据此证明读回。加强为按首个 `turn.finished.seq` 分隔事件后，第一次复测提交 **2 个 Turn**、退出码 **1**：第二 Turn 为 `turn.finished: failed`，有一次工具启动与结束，标记未在回答中。另起临时环境第二次加强版复测提交 **2 个 Turn**、退出码 **0**：首 Turn 在自有 Workspace 创建文件且宿主读到正确内容，第二 Turn 自身有工具启动/结束，`turn.finished: completed` 且回答含文件标记；本次可证实同 Session 的文件创建和工具读回。此前失败的实际原因仍未证实，不能声称链路稳定。结果中的 `paidTurns` 仅是已提交 Turn 数，不代表计费平台实际扣费数。失败运行不计为通过或宣称零费用。全程最多每次运行两个 Turn、无外部消息/用户数据清理，模型认证使用已有配置，不输出凭据或回复正文。

两个实际 Pi 链路覆盖普通回复与文件创建/工具读回；一次按 Turn 边界的复测失败、一次通过，仍需排查失败是否偶发。不代替其它 Runtime/模型、模型切换、审批、停止、恢复或完整票据签收。旧 `apps/e2e/pi-provider-https-offline.test.ts` 的独立回归仍然失败，不能因付费链路通过而抹去。

## 仍未验证/交付

- 上传与其进度/恢复；显式重开目前已通过 Test Agent 桌面/手机浏览器验证，尚未覆盖 Worker 断线时的重开拒绝。模型从 Worker 清单消失时，UI 可选择同一 Agent 当前可用的模型，尚未进行独立真实浏览器负例验收。
- 真实 Pi `5.3-flash` 协调首发与同 Session 文件创建、工具读回在加强版按 Turn 分隔后通过一次；此前第二 Turn 失败一次，原因待诊断，不据此称稳定。其它模型/Runtime、Pi 实际模型切换/停止/审批及旧离线 Pi 用例的签名队列适配尚未完成。Test Agent 仍只作为可重复集成证据。
- Worker 进程断线与同 home 重连、非成员 HTTP 负例、原生审批、运行中 Turn 停止与失败后会话再次发送已在真实浏览器脚本中验证；网络半断开/恢复、模型切换、审批超时、未知结果重试与跨 Team/Project/Worker 授权矩阵仍未完成。四个定向 Server 测试文件 **15/15**，`npm run typecheck --workspace @wemux/web-next` 退出码 0。新增 Server 全量原始 Node 串行运行 (`TMPDIR` 为磁盘目录) **951/951 pass，退出码 0，约 380 秒**；首次运行 **948/951**，三项迁移测试仍按“最后迁移”位置重放，而 Team 协调迁移新增了末尾条目，已修复测试定位并单独复测 15/15 后全量复测。三个测试修改不改变生产迁移。
- Team Session 持久来源升级测试 `apps/server/src/test/team-coordination-source-migration.test.ts`：既有普通 Session 保留、迁移可重放，Team Task 绑定的 owner/Worker/Agent/Project Team/Run 越界被数据库拒绝（2/2）；`apps/server/src/test/capability-task-projection.test.ts` 覆盖 Team 成员移除后既有 Turn grant 和 Session 读取失效。定向合跑 `team-coordination-functional`、`team-coordination-entry`、`team-coordination-source-migration`、`capability-task-projection` 四文件 15/15 通过；全套 Server 结果见上文。
- 旧的 `apps/e2e/pi-provider-https-offline.test.ts` 在本机 Pi 1.0.4 + 自有 HTTPS 假模型下重跑为 **0/1**：断言 `WorkerRuntime turn completed` 失败（第 91 行）；该用例的 WorkerRuntime 部分仍直接发送无签名的集群 `session.enqueue`，与当前签名命令合同不符。直接 Pi RPC 的成功不等于 Team 协调真实 Runtime 验收；此处保留失败，尚未修复/补齐端到端证据。
- 通用 Connector grant 与命令帧安全加固票 01/02 未完成；并非用户决定的协调专属隔离开门前置，仍须独立跟踪。
