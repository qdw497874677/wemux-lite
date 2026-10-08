# Phase 1 票 04 / 07 的当前证据与差额

状态：**票 04 有界八项已按其原票关门记录，票 07 八项复合验收全部 OPEN；01-06 为差额核对，不新开 Run 或审批能力。** 本页是阶段 1 当前工作树的索引，不把不同源码时点的局部成功拼成 01-11 的同一候选验收。原票：`.scratch/web-next-project-agent-platform/issues/04-task-session-conversation.md`、`07-run-completion-review-attention.md`。历史原始证据和逐轮审查详见 `docs/acceptance/web-next-dedicated-conversation-task.md`、`docs/acceptance/web-next-task-run-increment.md`；不根据历史日志标题、截图是否存在或测试文件名推断本候选通过。

## 票 04：八项有界行为的当前入口和不能外推的部分

| 原票标准 | 当前实现和已有验证范围 | 阶段门 |
| --- | --- | --- |
| 1 Task 绑定和试聊专用 Task 复用键（不含 Model） | `apps/server/src/application/dedicated-conversation-task.ts`、`apps/server/src/application/server-service.ts`；根 API、Next 试聊真实 Worker/Test Agent 浏览器及并发/重开单测，原票关门记载为已验 | 01-11 同候选复核；独立 Worker 本地 Task 属 Phase 5 |
| 2 多 Session、不可换绑、旧根入口转换及发送兼容 | `apps/server/src/application/task-service.ts`、`apps/server/src/application/server-service.ts`、`apps/web-next/src/components/TaskSessions.tsx`；旧根 API 真实创建/发送及回执重放、显式 Task 检查已有证据 | 旧兼容权限不按 `/next` 路径分叉；旧入口最终清理由后续票 15 核实 |
| 3 真实 Worker 对话、Journal、工具/错误/用量/新鲜度及恢复 | `apps/e2e/next-worker-conversation-browser.mjs`、`apps/e2e/approvals-pi-agent.mjs`；Test Agent 浏览器与获授权的原生 Pi 有界路径分别取证 | Pi 正常路径不等于所有 Provider 错误/独立宿主 |
| 4 队列、取消、停止、结构化工具审批、拒绝/超时 | `apps/worker/test/{worker,model-command}.test.ts`、`apps/e2e/approvals-pi-agent.mjs`；停止准备竞态分层测试、原生 Pi 手机审批/拒绝/五分钟超时样本 | 不借 Run 取消或 ReviewRequest 证据顶替工具审批；本地分层证明不等于所有恢复竞态 |
| 5 同 Session 下一个 Turn 的模型切换与执行快照 | `apps/server/src/application/server-service.ts`、`apps/e2e/approvals-pi-agent.mjs`；桌面/手机 Next 完整路径与两 Turn 实际模型 Journal | 不修改正在运行 Turn 的快照；无付费请求新授权时仅复验可重复离线样本 |
| 6 不支持/不可用/失权明确拒绝 | `packages/web-contract/src/action-capability.ts`、`apps/server/src/application/task-service.ts` 的能力和校验；原票分层回归 | 不偷偷创建另一 Session、换 Agent 或回退模型 |
| 7 重连补传、响应丢失、草稿/历史、取消竞态 | `apps/worker/test/model-command.test.ts`、`apps/e2e/next-worker-conversation-browser.mjs`；原票关门补充准备期停止与幂等 | 与普通 Task 的 **Run** 三态取消和 reuse 是两套验收，不互相代替 |
| 8 桌面/手机 Task→Session→审批/停止→模型→刷新 | `apps/e2e/approvals-pi-agent.mjs` 的显式 full-journey，原票列两端真实 Pi、页面异常零、独立有界复审 | 已获用户此前限量模型授权仅为历史运行；**本轮未请求/运行付费模型**；完整移动视觉与双宿主仍单列 |

旧 `docs/acceptance/web-next-dedicated-conversation-task.md` 顶部和部分增量段落保留当时“in-progress”的历史时点，原票 2026-10-04 关门八项是后续记录；不得用旧 partial 反证其后关门，也不能把历史关门当本候选已经验收。票 03 的 Project/Workspace/Task 前置与旧根转换不因本矩阵解决；Phase 5 的独立 Worker Web/API 不属这八项有界集群路径。

## 票 07：逐项组合验收矩阵（八项均未勾选）

| # | 原票复合要求与当前可核对证据 | 未证实的必要部分、后续切片 |
| --- | --- | --- |
| 1 | 普通 Task 启动 Run、实际 Session/排队/运行/结果/故障、重试/启动/取消/完成竞态。`apps/server/src/application/task-service.ts` launch/cancel、`apps/web-next/src/components/TaskRuns.tsx` 展示、`apps/e2e/next-worker-task-run-browser.mjs` 有真实 Test Agent 成功/停止样本；Server `apps/server/src/test/task-runs.test.ts` 有三态竞态与回执的有界测试 | **01-07（进行中）**：Next 已新增显式复用选择、原请求重试保留 `mode/reuseSessionId`，服务端仍权威判定空闲与绑定；该 UI 已通过类型检查，真实 Worker/浏览器复用、确定性 Test Agent 显式 `[test-agent:fail]` 失败及两种取消的本轮证据见下文。真实 Worker 的启动/取消/完成全面竞态及重连后收据与 Journal 一致仍未证明。单测或合成 Run 不等于真实竞态；缺外部能力须 blocked；01-11 重验 |
| 2 | 显式提交完成 UI/API、无审查 done、Run 不自动 done。`apps/server/src/application/task-service.ts:296-327` `complete` 核验当前版本、最新成功 Run、活动阻塞、摘要证据和策略；`apps/web-next/src/components/TaskRuns.tsx` 表单；`apps/e2e/next-worker-task-run-browser.mjs` 已有真实 Test Agent 无审查样本 | **01-08**：新项目默认、当前候选权限/CAS/响应丢失、失败/取消阻塞与真实 Worker 桌面/手机一体复验，不能拿手工写入 succeeded 的旧浏览器夹具代替；01-11 同候选 |
| 3 | 新 Project 默认 none；Project owner/manager 可更新 `none/agent/human/multi-stage`（`apps/server/src/application/project-access-service.ts:58-85`），Task metadata 可覆盖且首次 Run 固定（`apps/server/src/application/task-service.ts:435-451,677-699`） | **01-08**：逐创建/激活继承、后改默认与获权覆盖的实际 UI/API/CAS/重放/越权；Agent 与多阶段目前配置名可保存但执行路径未交付，不能把配置能力冒充流程；01-09 和 01-11 |
| 4 | 不降级、不跳阶段。`reviewPolicyFrozen` 的后续修改守卫、`packages/web-contract/src/action-capability.ts` 禁止普通状态改成 done；已有策略能力一致性和 Server 负例 | **01-08**：执行 Agent 对已启动 Task/项目策略的越权负例、活跃 Task 旧默认固定；**01-09**：真正阶段顺序、每阶段授权/不得跳过的回执和竞态；未做 Agent/multi-stage 前仅是 fail-closed，不是该项通过 |
| 5 | 当前单阶段人工：`apps/server/src/application/task-service.ts:155-213`、`apps/e2e/next-worker-human-review-browser.mjs`；实际两次 Test Agent Run/要求修改/再提交/批准，独立 manager 与作者分离，异常路径有定向测试 | **01-09**：真实 Agent 审查者和多阶段推进/修改/失败原因与等待投影尚无完整状态机及受权参与者证据；不得由人工单阶段批准替代。没有获授权真实 Agent 时该子门保持 blocked；01-11 同候选 |
| 6 | 任务活动/人工审批待办来自真实 DB/API、分页、Task 导航；`apps/server/src/application/attention-service.ts:26-68` 的 approval/run_problem 有界来源及 `apps/e2e/next-attention-review-browser.mjs` 的人工审查浏览器实测 | **01-10**：`attention-service.ts:30-37` 对 `task_assignment` 返回 422；全来源受权操作、空态、实际汇总来源和 Session 精确回访需补；协调计划批准属后续票 12、工具审批属票 04，不得误作普通 Task ReviewRequest；01-11 |
| 7 | 摘要/证据在 `TaskService.complete/submitHumanReview` 活动与 ReviewRequest 中持久化，Next Task 页面可读，真实人工两轮脚本核对 Run/Review/activity | **01-08**：当前候选结果引用/权限/重载验证；完整文件成果展示归票 10，票 12 后续计划批准不得改变普通任务完成策略；01-11 |
| 8 | 真实单阶段人工的双视口独立账号闭环 `apps/e2e/next-worker-human-review-browser.mjs`（历史证据合计 6 checks、4 个真实 Test Agent Run）；辅助 HTTP 校验重复/撤权，另有合成审查表单浏览器 | **01-07/08/09/10** 分别补真实 Run/reuse竞态、无审查完成、Agent/多阶段及待办各入口与越权/CAS/重放；01-10 逐张人工视觉审核和失败清理/脱敏，**01-11** 同一冻结候选统一复跑。不同轮次的截图、Server 单测、真实 Worker 人审不能拼成组合项通过 |

## 执行门与可独立推进次序

- **01-07** 正在补 Run 生命周期与 Session reuse：Next 选择器、受控 Worker/浏览器的双端复用/故障/取消证据均为局部，仍需重连及竞态矩阵，由 01-11 同候选复验；无真实执行时仅标局部。不得改审查决定语义解决取消红灯。

### 01-07 新增受控 Worker 实证（局部，不是票 07 或阶段签收）

`apps/e2e/next-worker-task-run-browser.mjs` 以临时 Server SQLite、Worker CLI、确定性无模型 Test Agent、私有 Next 构建 `/tmp/wemux-next-01-07-build` 在桌面和手机各执行四段：从 UI 显式选择原 Session 发起第 2 次 Run，同一 Session/不同 Run/两次真实 terminal Journal、精确 launch 重放与改载荷 409、仅最新成功 Run 允许显式完成；正在运行时取消并核对 cancelled Journal；暂停本轮拥有的 Worker，在 pending 时请求取消，恢复后核对 cancelled 与 UI；以显式 `[test-agent:fail]` 注入真实 Worker 失败，核对唯一 failed terminal、可见 `agent-error` 诊断、Task 不自动完成且无完成按钮。原始八条通过、`errors=[]`、Run 身份和截图保存在 `/tmp/wemux-next-worker-run-browser-CbXT3v/result.json`、同目录 PNG 和 `cleanup.json`；本地 `apps/worker/test/test-agent.test.ts` 3/3（`/tmp/wemux-phase1-0107-test-agent.log`）、`apps/server/src/test/task-runs.test.ts` 125/125（`/tmp/wemux-phase1-0107-runs.log`）、Server/Worker/Next 类型检查通过。独立只读复审仍待完成。

**重要竞态边界：** pending 取消时 Worker 曾暂停，但恢复后每端仍观测到一次 `turn.started`，再由取消收敛到 cancelled。这证明 pending 请求最终收敛，**不证明排队取消阻止 Turn 启动**，不能写成“queued-before-start 被命中”或 “零启动”；在 01-07/01-11 仍需确定性排队窗口与停止/自然完成抢占验证。上述均为集群 Worker/Test Agent，不是 Pi/Claude、真实审查 Agent、Worker 独立宿主或全来源待办。私有临时数据库可能含鉴权态，不公开原始 SQLite；截图尚待逐张视觉审查，候选及构建还未冻结。
### 01-07 本轮同候选复验（2026-10-07，含严格 reuse 规则）

当前 dirty 快照（1030 个未提交文件）上重建私有构建并完整复跑：先 `npm run build:packages`（本轮 `packages/web-contract/src/action-capability.ts` 与 `apps/server/src/application/action-capabilities.ts` 新增严格判定：候选 Session 必须 `session.taskId === task.id` 且被本 Task 的历史 Run 引用，未引用的 Task Session 一律 409 `reuse_ineligible`，无写入与通知）；Next 产物 `/tmp/wemux-p1-t07-run-1791383372/ui`（index.html SHA256 前缀 `50c2ae91d31ffd0b`），`node scripts/test-with-browser.mjs -- node --import tsx apps/e2e/next-worker-task-run-browser.mjs` exit 0、八条 checks、`errors=[]`，证据 `/tmp/wemux-next-worker-run-browser-I6mi5a/`（result.json、桌面/手机各四张 PNG、cleanup.json）、日志 `/tmp/wemux-p1-t07-browser.log`。本轮服务端确定性补强：`apps/server/src/test/task-runs.test.ts` 126/126（新增排队取消：accepted cancel 非终结证据，`message.queued`+`message.cancelled` 后无 turnId/startedAt/`run.started` 活动、仅一条 `run.finished`，重复回执与重复取消不重开；完成/取消抢占两测补终态与 activeRun 清理断言；idle 安全测试改为先落历史 Run 再检测独立 pending enqueue）、`apps/server/src/test/reuse-rejections.test.ts` 23/23（未引用 Session 409 `reuse_ineligible`；终态历史 Run 引用 + 新鲜空闲 Journal 放行；非终态/未收敛取消仍拒）、`apps/worker/test/test-agent.test.ts` 3/3。竞态边界不变：暂停恢复后每端 `turn.started` 计 1，不证明排队取消阻止 Turn 启动；取消与自然完成抢占仅服务端投影确定性，无真实 Worker 端到端；重连后收据/Journal 一致仍未证；Test Agent 非真实审查 Agent；快照未冻结，01-11 同候选重验。

- **01-08** 在可靠 Run 事实之上补明确完成/默认策略/继承覆盖/成果引用；Server 与真实 Test Agent 无审查正反例可独立验证，不需要付费模型，但 Project/Task 权限必须真实。
- **01-09** 人工单阶段现有样本仅作基线；Agent/多阶段的阶段模型、真实参与者、CAS、等待/失败状态需要新证据。真实 Agent 受权和环境不具备就只交付无付费验证部分，验收门留 blocked；协调 Task 与工具审批不被并入。
- **01-10** 补受权的 assignment/审批/异常来源汇总及有界分页，真实身份的桌面/手机回访和逐图人工视觉。来源尚不存在时明确未支持而不是伪造可操作；跨票未来接入只记接口边界。
- **01-11** 只在 01-01..10 及真实 Google/SMTP 等外部门具备后固定 HEAD + dirty 源码/产物身份，集中同候选重跑五票并申请签收；当前 01-04 历史 Task 删除缺执行终结证明，仍保留 `task_has_sessions` fail-closed；01-05 个人隐藏的本地证据也不解除它。任何 BLOCK/外部门缺失时 Phase 1 保持 OPEN，旧版/数据保留。

本矩阵仅是 01-06 的证据边界与计划索引，**没有在本计划运行新真实模型、实现审查阶段或勾选票 07**。
