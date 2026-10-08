# Ticket04 真实 Worker 的 Next 对话验收

状态：主会话完成本节限定的执行与浏览器验收。最终只读复审 `be1782c8-6f71-4e55-9121-efe5a3d4973d` 为 **OK**，未发现问题；初审 `870f1ace-c2fa-4c49-90ad-683f0696133f` 的环境继承 P1 和遗漏传输库清理 P2 均已关闭。审查者核对源码与主会话日志，并独立只读检查清理后的目录，未重新执行测试。此结论仅适用于本测试和文档增量。Ticket04 仍 in-progress；按用户要求，04 收尾后才开始 05。

## 执行边界

脚本 `apps/e2e/next-worker-conversation-browser.mjs` 启动临时 Server、实际 Worker CLI 进程和真实 Chromium，Worker 经注册、WebSocket 传输、自己的 SQLite 与 Runtime 执行。未插入合成 Worker、命令收据或 Journal 事件。使用随 Worker 提供的确定性 Test Agent，不使用本机原生 Agent、不调用模型提供方、不产生费用。此区别必须保留：真实 Worker 控制链路不等于真实 Pi/Claude 等原生 Runtime 验收。

测试账号只在自有临时库中初始化；Project、Task、Workspace、注册、创建 Session 与操作通过公开 API/实际 UI。端口动态分配，Vite 只写 `/tmp`，未改运行中的服务、生产数据库或全局安装。修正后的测试退出关闭自有浏览器、Worker、Server，移除自有 Worker home 和 Server 主库、传输库及各自 WAL/SHM。历史首轮遗漏传输库，不能将其 cleanup.json 当作完整清理证明。

## 桌面与手机已验证

1440×1000 与 390×844 各完成以下五组断言，共 10 组：

1. 实际 Worker 上报 Test Agent，实际 provision 空 Workspace；Next Task 页面显式选择环境创建 Session，验证固定 taskId 和 Worker 接收命令。
2. 丢弃成功发送的 HTTP 响应，刷新后点击原消息重试；body 与 commandId 完全相同，Worker Journal 仅一条 message.queued、一个 Turn。UI 显示真实 echo 工具和助手输出。
3. 暂停当前 Test Turn，排队两条消息，经浏览器取消指定后一条，再停止指定当前 Turn；Worker 确认精确取消事件，保留的后续消息执行一次，UI 展示真实结果。不是收到 HTTP202 即视为成功。
4. Test Agent 不支持模型切换，UI 显示固定模型提示并禁用选择，不伪造切换能力。
5. 保存草稿、停止 Worker，确认公开状态和 UI 显示离线；以同一 home 重启、刷新浏览器，同 Session/草稿/工具历史恢复；新消息完成且历史 synced。Task 下仍只有一个 Session、没有 Run。

## 可复查证据

- 基础真实 Server/Worker CLI 回归 `apps/e2e/full-stack.test.ts`：1/1 通过，`/tmp/wemux-ticket04-closeout/full-stack-baseline.log`。
- 当前 Next 私有 Vite 构建通过，`/tmp/wemux-ticket04-closeout/build.log`；脚本 syntax、diff check 通过。
- 最终脚本浏览器 10 组检查通过，`/tmp/wemux-ticket04-closeout/browser-final.log`，结果与桌面/手机截图 `/tmp/wemux-next-worker-browser-3QimHv/`，含 result.json/cleanup.json。
- 首跑使用错误按钮名称“重试原消息请求”超时；源码实际名称是“重试原消息”。这是脚本定位错误，修正后通过；保留 `browser.log` 及 `/tmp/wemux-next-worker-browser-4SMw1h/failure.json`，不称为产品修复或产品红绿证明。
- 中间通过日志 `browser-2.log`，结果 `/tmp/wemux-next-worker-browser-YUzeC6/`。随后把 route/unroute 共用同一匹配函数以确保移除拦截，最终源重新执行通过。

复现：

```sh
node_modules/.bin/vite build --config apps/web-next/vite.config.ts --outDir /tmp/wemux-ticket04-closeout/next-dist
WEMUX_NEXT_TEST_DIST=/tmp/wemux-ticket04-closeout/next-dist \
PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
node --import tsx apps/e2e/next-worker-conversation-browser.mjs
```

## 初审修正与重新验证

- 子进程配置统一由 `apps/e2e/owned-worker-fixture.mjs` 构建：复制环境并移除 WEMUX 配置与大小写代理变量；注册、启动、重启全部显式设置单一 loopback `--server/--servers`、direct transport/preference、loopback host 和动态端口，不修改父进程环境。
- 同一 helper 在 Server 关闭后删除主库、`.transport` 及各自 WAL/SHM，逐一确认不存在后才返回。清理不会删除截图或结果文件。
- `apps/e2e/owned-worker-fixture.test.ts` 验证恶意候选地址/传输/代理覆盖不生效、配置解析后候选仅为 owned origin、父环境不变，以及六类数据库文件删除、保留证据和重复清理。先抽出与旧脚本等价的环境继承/三文件清理 helper，2/2 红；修正后 2/2 绿。红灯是被提取 helper 的行为验证，不是旧浏览器脚本的外部连接实测。
- 实际浏览器再次注入 `WEMUX_SERVER_URL=http://127.0.0.1:1`、同值 `WEMUX_SERVER_URLS`、`WEMUX_TRANSPORT=nc`、`WEMUX_PREFER=tailnet`，最终 **10 组通过**，说明注册及两次重启不被这些环境覆盖。未连接外部 Server，也不声称已做网络抓包证明。
- 修正证据 `/tmp/wemux-ticket04-closeout/review-{red,green,browser,cleanup}.log`；浏览器最终 `/tmp/wemux-next-worker-browser-lRm45s/`。父会话另查目录，确认无 `worker` 或 `server.sqlite*` 残留，保留结果/截图/cleanup。script syntax、diff check 通过。无产品代码改动，复用本节已有构建。

## 04 尚未关闭的要求

- 项目测试/试聊自动专用 Task 按用户、Project、Workspace、Worker、Agent、场景复用（不含 Model），以及旧根创建入口转换尚未交付；不能把已有普通 Task 创建当作此项通过。
- 原生 Runtime 的审批、模型切换、错误/用量和完整浏览器链路仍需实测；本脚本不涉及审批、审批超时或模型变更成功。
- 本节只有优雅 Worker 重启，不证明进程崩溃、服务端重启、离线期间发送/补传或所有故障恢复。
- 截图不是视觉批准；Worker 独立宿主本地 Task/新版流程属于后续 13–14，不把尚未实施的双宿主标为完成。

不因这一增量勾选整票综合验收，不将 Ticket05 提前标为已开始。
