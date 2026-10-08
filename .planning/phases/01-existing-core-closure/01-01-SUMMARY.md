---
phase: 01-existing-core-closure
plan: '01'
status: completed-locally
requirements: [NEXT-01, NEXT-02, NEXT-03, NEXT-04, NEXT-07]
---

# 01-01 执行摘要：安全与 Server 基线

已完成本计划的局部安全归属、夹具裁定、回归和只读复审；**五票及阶段 1 未签收**，后续 01-11 须冻结同一候选重跑。候选源码为 HEAD `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255` 加共享未提交工作树，非独立提交；详见 `docs/acceptance/web-next-phase1-baseline.md`。

- #58：六个 SSE/路由文件逐 hunk 审阅，归属本票的原始凭据重验/撤权留存，`apps/server/src/http/handler.ts` 的既有变化未借机改动。Canvas SSE 额外修复无界写缓冲与未校验先写心跳；二次只读安全复审无 blocker，不能以文件名或受控测试冒充真实浏览器最终验收。
- #57：生产路由有 terminalStreams 注入，旧夹具没有；删除 Task 的新 terminal SSE 应为 404，已建立连接另验 200，不为绿测篡改生产行为。
- #60：关闭写通道按 Ticket10 R2 保持鉴权后 403 `write_channel_closed`，未授权仍 401 / scope 错误；canvas 404 隐藏不可见私有会话，presence 允许竞态中已排队更新后撤销；定向测试与 Server 全量回归复跑。
- 原始命令证据 `/tmp/wemux-phase1-focused-canvas-fix2.log` (38/38)；`/tmp/wemux-phase1-server-canvas-fix4.log` (909/909，0 fail)，`/tmp/wemux-phase1-server-canvas-fix4.exit` 明确 shell 退出码 0；`/tmp/wemux-phase1-typecheck-canvas-fix.log` 类型检查；`git diff --check` 无异常。较早失败轮保留原始日志，不作成功证据。未运行外部 Google/SMTP 或付费 Runtime。

下一步 01-02 新版入口逐条证据/真实账号双视口复验，缺真实身份或部署授权须标 blocked，不得以隔离夹具替代同实例门。01-11 负责统一候选复验及人工逐票签收。
