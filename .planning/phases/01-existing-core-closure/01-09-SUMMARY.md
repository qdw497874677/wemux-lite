# 01-09 多阶段审查状态机与阶段隔离决策（阶段 1）

状态：**本计划可本地验证部分完成；Agent 审查策略门保持 blocked，票 07 继续 OPEN。** 分层证据在 `docs/acceptance/web-next-task-run-increment.md`（末节 2026-10-07 多阶段审查链）。

## 已实现并验证（当前快照）

- 多阶段策略端到端（Server）：`apps/server/src/application/task-service.ts` 提交（`submitHumanReview`，stage 1）→ 逐段决定（`decideHumanReview`）→ 阶段推进/最终完成/要求修改回实施；固定两段链（`stageIndex/stageCount`），未通过阶段不得跳过；同一 Run 上已批准前序阶段的参与者与提交者禁止再决定后续阶段（`forbidden`）；关闭后的阶段不可经新请求重决（CAS 先行拒绝）。多阶段推进同样观察 Task CAS：`transitionTask` 对 `in_review→in_review` 是同态，补显式 `version+1`（`apps/server/src/application/task-service.ts:213` 一带，服务测试断言 `advanced.task.version === submission.task.version + 1`）。
- 客户端恢复语义修复：`packages/web-client/src/pending-human-decision.ts` `matches()` 原先只认终态回执（`currentReviewId===null` 且 `done`/`in_progress`），把合法的阶段推进回执当"回执与原请求不符"。现接受推进回执（`status==='in_review'` 且 `currentReviewId` 为不同于已决阶段的有效后继），其余校验（版本 +1、reviewer/actor 身份、时间戳序、closedAt===decidedAt）不变。`packages/web-client/tests/pending-human-decision.test.mjs` 新增推进回执正/反例，80/80。
- 新版 UI：`apps/web-next/src/components/TaskRuns.tsx` 多阶段提交/决定面（第 X/Y 阶段审查决定、批准并进入下一阶段/批准并完成、提交者无决定按钮）；推进成功提示区分三态（完成/推进下一阶段/要求修改回实施）。
- 真实 Worker + 确定性 Test Agent + Next Chromium（桌面 1440x1000 / 手机 390x844）：`apps/e2e/next-multi-stage-review-browser.mjs` 2 条 checks、`errors=[]`、退出码 0。场景：多阶段默认在首次 Run 前仍可改项目默认、launch 后冻结快照 → 真实 Worker/Test Agent Run 成功不自动完成 → 提交者（实例管理员）提交分级审查 → 阶段 1 获权管理者批准推进（1/2）→ 同一管理者对阶段 2 决定被服务端 403 拒绝（页面 alert、任务仍 in_review）→ 阶段 2 另一获权管理者批准 → done；活动链含 `review.submitted` 与 `review.stage_advanced`，`currentReviewId` 清空。证据截图与脚本输出在 `/tmp/wemux-next-multi-stage-review-Ji0W3u/`。
- 回归：`@wemux/server` 全量 917/917；`@wemux/web-client` 318 pass/0 fail；`@wemux/web-next` 经 `node scripts/test-with-browser.mjs` 166/166（含真实 App abort 甲骨文与 Attention 光标分页）；`tsc -b apps/server packages/web-client apps/web-next` 全 0；`npm run build --workspace @wemux/web-client` 后 dist 测试同步通过。
- 阶段回执重播授权：`authorizeReviewReplay` 对阶段链各段回执按"当前获权者可读、失去管理权即失去、前序阶段决定者不得读后段回执"验证（`apps/server/src/test/multi-stage-review.test.ts` 能力/重播用例）；`reuse-rejections.test.ts` 公开服务矩阵同步（terminal 历史 Run 引用的 Session 复用受理、未引用 Session 409 `reuse_ineligible`）。

## 明确未证（不勾选对应票项）

- **Agent 审查策略**：无真实已授权 Agent 决策面（Test Agent 是确定性执行器，非获权审查决策面；禁止用付费 Runtime 或伪造批准替代），该门保持 blocked，票 07 因此继续 OPEN。
- 配置 `agent` 策略的正/负浏览器演练、外部付费 Runtime、双宿主：未实现或未验收，不冒认。
- `changes_requested` 在多阶段第 2 段回实施的浏览器路径仅服务端测试覆盖（浏览器脚本只演练批准链）；单阶段人工沿用 01-05/01-08 已有真实账号证据。
- 工作树未提交文件多（共享工作树）；01-11 冻结候选后串行复验。

## 遗留

- 无新增 BLOCK。下一计划 01-10（按阶段文件顺序推进）。
