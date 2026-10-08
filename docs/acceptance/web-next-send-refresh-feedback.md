# Ticket04 刷新竞态下的发送反馈

状态：有界修复已通过本节验证，独立只读审查 `134d7e8c-68b8-43ab-9649-e5f55725fba9` 为 **OK with notes**，未发现问题。Ticket04 仍 in-progress，Ticket05 尚未开始。本节不关闭全部浏览器间歇失败。

## 发现与边界

原始诊断目录 `/tmp/wemux-worker-browser-diagnosis/`，自有临时 Server、实际 Worker CLI、确定性 Test Agent，无付费调用。重复运行捕获了不同边界，不能混作一个根因：

- `/tmp/wemux-next-worker-browser-yfluuW/`：手机丢响应场景未产生 POST，草稿保留且没有 intent。失败实际在发送前，不能称为响应恢复失败。
- `/tmp/wemux-next-worker-browser-ldCIJI/`：停止按钮 pointerdown/up 时已禁用，未触发 click。
- `/tmp/wemux-next-worker-browser-CoICU4/`：发送按钮未禁用且 click/submit 均触发，但无新 POST/intent，旧消息收据与新草稿保留。结合生产处理函数的实时准入检查，定位到刷新状态在渲染与处理之间变化时静默返回的可达分支。
- 一度尝试仅在文档未捕获 click/submit 时重复手势；`gesture-guard-3.log` 仍在停止步骤失败，故撤掉该辅助重试。现有脚本只记录单次真实手势，不重复或合成点击。`/tmp/wemux-next-worker-browser-IqCsP8/` 保留该失败，不作修复成功证据。

## 本次修复

`apps/web-next/src/components/ConversationComposer.tsx` 在实际 submit/retry 处理时再次检查当前准入条件；若条件失效，显示“本次未发送”及原因，明确恢复后需用户手动操作。反馈按 api 实例和完整 scope key 隔离，下一次合格的显式操作清除反馈。

不改变权限或新鲜度门槛，不创建请求、不清空草稿、不自动发送。文案只描述本次尝试，不能否定之前未确认请求可能已被接收。native disabled 阻止事件派发的情况仍由既有禁用说明承担，本修复不保证每个指针手势都能提交。

## 可重复验证

`apps/e2e/next-composer-browser.mjs` 新增桌面/手机受控元数据读取：在 pointerdown 后刷新并保持真实 HTTP metadata 的客户端应用，确认按钮禁用；pointerup 不发送。再用原生 form.requestSubmit 单独触达 submit handler 边界，断言明确未发送反馈、零 POST、无 intent、草稿保留。释放刷新后仍无自动发送且保留反馈，后续显式正常发送清除反馈。

这里的 requestSubmit 是受控 handler 边界验证，不冒称复现了原始 SSE/React 的全部时序；原指针用例与真实 Worker 重复运行分别保留。

命令所需环境：

```bash
PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
WEMUX_NEXT_TEST_DIST=/tmp/wemux-worker-browser-diagnosis/not-sent-dist \
node --import tsx apps/e2e/next-composer-browser.mjs
```

- `not-sent-red.log`：旧构建在新增明确反馈断言超时，符合预期。
- `not-sent-types.log`、`not-sent-build.log`：Next noEmit 与私有临时 Vite 构建命令退出 0。
- `not-sent-final.log`：composer 桌面/手机 **32 checks**，`/tmp/wemux-next-composer-browser-3IfYek/`。合成 Worker 能力与实际 HTTP，不是原生 Runtime。
- `not-sent-unit.log`：发送/控制 gate **8/8**，没有放宽刷新拒绝策略。
- `not-sent-worker.log`：新构建实际 Worker CLI + Test Agent **12 checks**，`/tmp/wemux-next-worker-browser-26UMfT/`。单轮通过不证明间歇问题全部解决。
- 初次 composer 命令缺少显式 Playwright 环境，配置门正确拒绝；`gesture.log` 保留，随后补充现有绝对路径运行，未修改配置门。

## 未关闭事项

停止操作在刷新窗口的可用性、其它手势/处理边界以及真实 Worker 脚本间歇稳定性仍需定位。原生 Runtime 审批、成功模型切换、错误用量、新版专用试聊入口与整票验收仍未完成。独立审查只覆盖本次未发送反馈，不能据此关闭 Ticket04 或启动 Ticket05。审查额外指出：新提示的跨生命周期隔离及拒绝重试组合目前由源码审查支持，没有针对这些提示状态组合的独立浏览器断言；类型检查退出状态由主会话记录。诊断原始数据可能包含本机发现的 Agent/Model 名称，应保留在私有临时目录，不随公开验收摘要发布。
