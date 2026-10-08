# 01-06 票 04 有界证据与票 07 差额矩阵

状态：**计划的文档/证据核对已完成；票 07 及阶段 1 未完成。** 目标是避免把过去不同源码时点的单阶段人审、Test Agent 和 Server 单测相加为八项复合验收。正文矩阵在 `docs/acceptance/web-next-phase1-conversation-run-gap.md`；原票和具体历史证据分别在 `.scratch/web-next-project-agent-platform/issues/{04-task-session-conversation,07-run-completion-review-attention}.md`、`docs/acceptance/web-next-{dedicated-conversation-task,task-run-increment}.md`。

- 票 04 八项在原票 2026-10-04 有界关门；本轮仅把其集群/真实 Worker/Test Agent/获授权真实 Pi、旧根转换、Session 模型/审批/停止/重试各层证据与独立宿主 Phase 5 边界并排记录，没有重新调用付费 Runtime 或追溯改写旧文档的历史 partial 状态。Phase 1 01-11 仍要在冻结的同一候选核对依赖。
- 票 07 八项仍未勾选。当前已有 `apps/server/src/application/task-service.ts` 的 Run、无审查明确完成、人工请求/决定及策略固定，Next TaskRuns 和真实 Worker/Test Agent 两次执行/要求修改/再提交/批准的有限证据；不等于 Session reuse、真实 Worker 的失败/取消全部三态、新项目默认/继承覆盖完整链、Agent/多阶段参与者、可操作全部待办、同候选桌面手机逐图视觉通过。
- 缺口切片：01-07 Run/reuse/竞态与真实投影；01-08 显式完成、默认策略/继承/覆盖、成果引用；01-09 Agent/人/多阶段的真正阶段与受权决定；01-10 受权、分页且可操作的待办和两视口逐图回访；01-11 同候选五票重新冻结及逐票签收。真实 Google/SMTP 的 01-03 外部门、01-04 安全历史删除阻塞和 01-05 同候选双账号双 Worker 组合均不因本矩阵解除。
- 本轮核对依据：读原票八项、`apps/server/src/application/{task-service,attention-service,project-access-service}.ts`、`packages/web-contract/src/action-capability.ts`、`apps/web-next/src/components/TaskRuns.tsx` 及 01-07..01-11 计划；已明确 `AttentionService.pages` 对 `task_assignment` 返回 422、`TaskRuns` 启动 UI 固定 new 模式，虽然服务端已有 reuse 合同。证据按源码与历史区分，不把受控协议 fixture 当真实 Worker，也不把原 Ticket04 有界关闭扩成跨阶段完成。
- 文档检查：`git diff --check` 无空白错误；这是只读证据映射，未新增生产代码、测试或浏览器脚本。独立只读复核若指出不符，以原票和当前源码修正矩阵，保持 OPEN。
