# Next 审批操作接入（部分验收）

主会话直接实现，尚待独立审查，不代表 Ticket04 完成。

## 实现

- `packages/web-client/src/session-conversation.ts` 复用既有鉴权 transport，向现有 `/api/sessions/:id/runtime/approvals/:approvalId` 发出固定 commandId、turnId、decision。校验接收身份，不把 HTTP202 当执行成功。
- `conversation-controls.ts` 既有持久控制槽增加 resolve-approval；批准/拒绝与停止/取消共享一个未解决槽，先保存再发送，刷新后显式原体重试，不改变目标或决定。
- Next Controls 接入结构化请求及批准/拒绝；新操作要求当前权威 Session/Turn 和已验证 pending 请求，重试仍核验会话写权限；Server/Worker 权限和执行校验仍为权威。
- 客户端历史投影与已接受 Server 生命周期对齐：请求前 resolution 不决议后来的请求；重复请求不改最早请求内容；Turn finish 使未决请求 expired（不是人工拒绝），终态不重开。原先“Turn finish 后仍 pending”的测试同步更新。
- Worker 审批按请求来源分流，真实 ConnectorRuntime 待决请求不能阻断其他 Session 的同 ID 原生审批。旧 connector mock 的请求修正为明确 connector 类型。

## 主会话验证

证据目录：`/tmp/wemux-parent-approval-fix/`。

- Worker 缺陷回归红 23/24，修复后身份/connector/runner/local-workbench 59/59；Worker typecheck。
- 共享客户端 205/205；新增审批 wire、丢响应重开重试及审批历史顺序测试。聚焦 62/62。
- Next 全测试 150/150；首次五项失败为 mock 缺新增 resolveApproval 方法，补齐 fixture 后通过。首次类型错误已修正为判别联合分支，Next typecheck 通过。
- packages 构建、临时 Vite 构建通过。
- 真实 Chromium 桌面/手机、隔离 Server HTTP 浏览器 24 项通过：`/tmp/wemux-next-controls-browser-38o5oR/`。含拒绝丢响应、原请求跨视图恢复、一次持久命令、Journal 决议和 Turn 结束后按钮移除，以及原取消/停止/身份切换场景。

可重复浏览器命令：

```sh
PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
WEMUX_NEXT_TEST_DIST=/tmp/wemux-parent-approval-fix/next-dist \
./node_modules/.bin/tsx apps/e2e/next-controls-browser.mjs
```

## 未完成项

浏览器使用合成 Worker/Journal，不是原生 Runtime 证明；Worker 回归使用真实 WorkerRuntime/SQLite/ConnectorRuntime 配合 fake native adapter 和受控 fetch，不发真实外部请求。审批真实超时、崩溃副作用确认、模型切换、自动专用 Task、真实 Runtime 端到端与双宿主验收仍待完成。截图未作视觉签字。不宣称全部剩余票据完成。
