# Team 协调聊天：真实浏览器受控验收（部分）

候选：`integration/web-next-coordination-closure`，功能合并 `b2220fa`，浏览器 E2E 脚本 `b422373` 及后续显式重开验证。**NEXT-05 与协调 spec 的 03/04 票均未整票验收**。历史阶段 2 隔离门 FAIL 的文档只记录当时状态；现在依据 [ADR 0008](../adr/0008-coordination-chat-ordinary-runtime-permissions.md) 用普通 Agent 权限提供协调聊天，不宣称 OS 文件/网络隔离。

## 本次可复查的通过项

- `npm run build:packages`，Server/Worker/Web-next `typecheck`：退出码 0。
- `apps/e2e/team-coordination-transport.mjs`：真实 Server、注册 Worker、签名 WS 首发、Test Agent 回显与完成、首发幂等、后续发送、同 home Worker 重启后历史恢复及非成员拒绝，共 4 组通过。
- `apps/e2e/team-coordination-first-send.mjs`：同类独立 Worker 首发/重复提交/继续发送，5 组通过。
- `apps/e2e/team-coordination-real-browser.mjs`：同一次候选构建 `/next/`，真实 Server/Worker/Test Agent + Chromium 桌面 1440×1000 与手机 390×844：登录 Team 页、选择已就绪的 Project Workspace/Worker/Agent、首发、等待消息回显与 Turn 完成、刷新后按 Session ID 恢复原历史，并显式在原协调 Task 下重开新 Session、再次完成对话、核对原 Task ID 与原历史，6 组通过，页面异常 0。失败日志只输出步骤、错误类型及异常计数，不打印浏览器错误消息或凭据。两视口各自创建自己的 Session；没有把一台手机与桌面共享同一浏览器登录状态当成跨设备同步验收。
- `apps/web-next/src/components/__tests__/TeamCoordination.test.mjs`：Playwright 浏览器组件测试通过；Worker 原始 Node 报告 509 pass/5 skip/0 fail；Web-next prepared 测试 168 pass/0 fail。Server 全套串行执行超过 300 秒而中止，不能记为全绿；定向 Team 功能测试已通过。

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

上述 Playwright 依赖路径为本机临时安装，运行时可换为等价环境变量；脚本只使用非付费 Test Agent，所有数据库/Worker home 由测试创建并在关闭后清理。没有调用付费 Runtime、外部投递或删除用户数据。

## 仍未验证/交付

- 上传与其进度/恢复；显式重开目前已通过 Test Agent 桌面/手机浏览器验证，尚未覆盖 Worker 断线时的重开拒绝。模型从 Worker 清单消失时，UI 可选择同一 Agent 当前可用的模型，尚未进行独立真实浏览器负例验收。
- 普通有效非付费 Runtime 的真实协调对话；Test Agent 不能代替 Pi/Claude/OpenCode 的验收。
- 会话审批、停止、模型切换、失败重试及断网重连的 Team 页真实浏览器逐项验收；跨 Team/Project/Worker 授权矩阵、迁移负例与完整 Server 套件。
- Team Session 持久来源升级测试 `apps/server/src/test/team-coordination-source-migration.test.ts`：既有普通 Session 保留、迁移可重放，Team Task 绑定的 owner/Worker/Agent/Project Team/Run 越界被数据库拒绝（2/2）；`apps/server/src/test/capability-task-projection.test.ts` 覆盖 Team 成员移除后既有 Turn grant 和 Session 读取失效。均为定向测试，不代表全套 Server 通过。
- 旧的 `apps/e2e/pi-provider-https-offline.test.ts` 在本机 Pi 1.0.4 + 自有 HTTPS 假模型下重跑为 **0/1**：断言 `WorkerRuntime turn completed` 失败（第 91 行）；该用例的 WorkerRuntime 部分仍直接发送无签名的集群 `session.enqueue`，与当前签名命令合同不符。直接 Pi RPC 的成功不等于 Team 协调真实 Runtime 验收；此处保留失败，尚未修复/补齐端到端证据。
- 通用 Connector grant 与命令帧安全加固票 01/02 未完成；并非用户决定的协调专属隔离开门前置，仍须独立跟踪。
