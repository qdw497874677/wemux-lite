# Paperclip 如何判断失败、无进展与自动恢复

## 结论

**Paperclip 分开处理 Run 执行结果、Issue 工作状态与恢复策略，不是“测试红灯就任务失败，自动修三次，exit 0 就完成”。**

- **代码硬判断**：进程退出码、信号、超时、Adapter 结构化错误、运行/等待路径、预算、并发、重试计数与幂等约束。
- **代码启发式**：输出是否仅有计划、是否存在可观察动作、连续成功却没有 Issue 可见进展。能自动分类、限次续跑、节流，但不能证明代码正确或需求完成。
- **Agent skill 约定**：判断工作是否完成，记录验证证据，显式提交 `done` / `blocked` / 审查或续跑路径；重复 blocked 且无人回复时不重复领任务、发评论。
- **自动恢复确实存在，且有持久化计数**：瞬态失败重试、无进展续跑、缺失任务处置路径修复是不同机制。此 SHA 的处置修复上限是 **5**，不是通用默认 3 次；瞬态失败与无进展续跑分别默认最多 **2 次追加尝试**。这些不等于“业务代码修复失败计数”。

## 研究范围与证据边界

固定第一方仓库 `paperclipai/paperclip`，SHA `d6df12cef69fcaf2d2fe66a393168931d5b8b4e7`。检查本地 `/home/qdw/Projects/research/sandbox` 后复用前轮 `/tmp/delegation-research/p-tree.json` 固定提交树，再按 Git blob API 获取所需源码；27 个缓存文件的 Git blob SHA 已与该提交树核对。所有引用均为固定 SHA URL，行号指上游文件，不指 Wemux。

本次为静态阅读：覆盖 heartbeat、process/Claude/Codex Adapter、Issue 路由与 service、liveness、rewake throttle、recovery、预算与相关 schema；参考测试源码但**未运行上游测试、服务、Agent 或第三方脚本**。没有全量验证所有 Adapter、native runtime、插件和部署配置；以下否定结论仅限定已追踪路径，不能外推为整个产品绝无某能力。

## 1. Run 失败不等于 Task 失败，exit 0 不等于完成

| 问题 | 代码实际判定 | 边界 |
| --- | --- | --- |
| heartbeat 何时 `failed` / `timed_out`？ | 先尊重已有终态、取消与 native finalization；非 native 分支中 `adapterResult.timedOut` → `timed_out`；无错误、无信号、取消未失败且 `(exitCode ?? 0) === 0` → `succeeded`，否则 `failed`。 | 是本次执行结果，不是 Issue 验收结论。甚至缺失退出码按 0 参与判断，因此要连同其他结果字段解读。 |
| process Adapter 如何处理？ | 超时直接上报；非零码产生 `Process exited with code …`；零码返回 stdout/stderr。 | 此处不解析 stdout 中的“测试失败”文字。 |
| Claude / Codex 一样吗？ | Claude 解析 `is_error`、`subtype`，`failed = !parsedSucceeded && (非零退出码或 is_error)`，还分类拒绝、认证等；Codex 所读常规返回分支按进程退出码决定 `errorMessage`。 | 不能假设每种 Adapter 对文本/结构化错误采用统一规则；Claude 局部 `failed` 计算也不能替代 heartbeat 最终结果。 |
| Issue 何时完成？ | `PATCH /issues/:id` 提交状态；service 在 `done` 设置 `completedAt`，`blocked` 设置 `blockedAt`。 | skill 要求完成范围、记录验证、没有剩余工作后才提交 `done`；审查/权限等路径另有约束，不是任何请求都无条件接受。 |

证据：[server/src/services/heartbeat.ts:25440–25472][outcome]；[server/src/adapters/process/execute.ts:98–135][process]；[packages/adapters/claude-local/src/server/execute.ts:1151–1269][claude]；[packages/adapters/codex-local/src/server/execute.ts:1538–1547][codex]；[server/src/routes/issues.ts:13327–13339][patch]；[server/src/services/issues.ts:310–338][status]；[skills/paperclip/SKILL.md:209–230][skill]。

**测试红灯的具体区别**：如果直接把测试命令作为 process Adapter 主进程，非零退出会导致该 **Run** 失败。如果测试只是 Agent 内部一次工具调用，测试失败不必然让 Agent 主进程非零退出；上述 heartbeat 不扫描全部测试日志判定 Issue 失败。工具失败可以成为 Agent 继续修正的输入，也可以最终形成明确 blocker。已读路径未证实“任意测试失败自动把 Issue 置失败并启动业务修复”的全局规则。

反过来，Agent 正常退出只说明本轮执行成功。`run-liveness` 在 Run 成功后仍可判为 `empty_response`、`plan_only`、`needs_followup`；只有 Issue 已 `done/cancelled` 才进入该分支的 `completed`。证据：[server/src/services/run-liveness.ts:321–368][live]。

## 2. 怎样发现“没有进展”

### 执行静默：可观测事实，不自动等于卡死

- watchdog 用最后输出时间，缺失则依次回退进程开始、Run 开始、创建时间；**5 分钟 suspicious、15 分钟 critical**。这是静默等级，不是质量判断。证据：[server/src/services/recovery/service.ts:168–170][watchtime]；[server/src/modules/active-run-watchdog/domain/policy.ts:19–40][watch]。
- 该 SHA 的 `scanSilentActiveRuns` 所调用实现会跳过 recovery 来源、blocked、已确认误报；有同一 Run 的终态证据才尝试收束执行，否则返回已有评估或 skipped。**不能仅凭函数名、结果字段 `created/escalated` 或历史测试，声称每次静默都创建修复任务或杀进程。** 证据：[server/src/modules/active-run-watchdog/application/use-cases.ts:241–296][watchscan]。
- Adapter 可以有更强独立措施：Codex 输出不活跃监视默认 **30 分钟**，显式 `null` 关闭；触发后返回 `errorCode: codex_output_inactivity_monitor`、`errorMessage`、`timedOut: false`。经常规 heartbeat 判定属于失败，而不是一律 `timed_out`。证据：[packages/adapters/codex-local/src/server/output-inactivity-monitor.ts:3–26][inactivity]；[packages/adapters/codex-local/src/server/execute.ts:1412–1422][inactivityresult]。

### 回合结束无进展：启发式 + 有界续跑

`run-liveness` 区分失败、阻塞、完成、空输出、仅计划、已推进和需跟进。所谓“具体动作证据”是评论、文档修订、工作产物、活动、工具/动作事件等计数；**单纯创建 Workspace 不算，但产生工具事件仍不证明测试通过**。证据：[server/src/services/run-liveness.ts:193–205][evidence]；[server/src/services/run-liveness.ts:321–368][live]。

`plan_only` / `empty_response` 有默认最多 **2 次追加 continuation**，限制同公司、仍归原 Agent、Issue 是 `todo/in_progress`、无 execution policy 阻挡、Agent 可调用、预算允许；幂等键包含 Issue、源 Run、状态、下次序号。用尽后写一次耗尽说明，要求人或 manager 检查，而非直接宣告任务 done。heartbeat 的这一调用在非 native 分支，native 不能据此类推。证据：[server/src/services/recovery/run-liveness-continuations.ts:8–15][cont]；[server/src/services/recovery/run-liveness-continuations.ts:106–153][guard]；[server/src/services/heartbeat.ts:13190–13227][exhaust]；[server/src/services/heartbeat.ts:25950–25969][conthook]。

### 重复自唤醒/空转：另有代码节流

同 Agent/Issue 连续 **2 次 succeeded 且无 Issue 可见进展**后，普通无事件唤醒冷却从 **120 秒**开始倍增，上限 **30 分钟**；样本窗口 6 小时、最多 8 个终态 Run。新输入、非 Agent 的显式 resume、特定事件等可以绕过；Agent 评论不会自动享有人类评论的豁免。failed/cancelled/interrupted 打断这一成功空转 streak，避免延迟故障恢复。证据：[server/src/services/issue-rewake-throttle.ts:27–40][throttleconst]；[server/src/services/issue-rewake-throttle.ts:108–181][throttle]。

这不是“禁止所有 self-wake”：确实有条件续跑，也有局部防自唤醒，例如 responding run 回答 interaction 后不再次 enqueue 自己。证据：[server/src/routes/issues.ts:16590–16605][self]。另需区分 **skill** 的 blocked 去重规则：最近是自己的 blocked 状态评论且无人回复则跳过，不 checkout、不重新评论；它不是已证实的全局服务端评论去重约束。证据：[skills/paperclip/SKILL.md:107–117][dedup]。

## 3. 是否自动发起修复？有，但必须区分修什么

| 机制 | 此 SHA 的边界与次数 | 证据 |
| --- | --- | --- |
| 瞬态上游失败恢复 | `failed` 且契约 error family 是 `transient_upstream/provider_quota` 才走对应重试；延迟数组 `[30_000, 30_000]`，无 jitter，最多 2 次；可尊重更晚 `retryNotBefore`。这条不是指数退避，也不是所有失败无脑重跑。 | [触发][retryhook]、[错误契约][contract]、[常量][retry]、[准入/时间][retryguard] |
| max-turn 耗尽续跑 | 默认启用，追加上限 2，默认延迟 1 秒；可配置，上限 10、延迟上限 5 分钟。 | [常量][maxturn]、[策略][maxpolicy] |
| 空输出/仅计划续跑 | 默认追加 2 次，状态、预算、归属和幂等门控制。 | [策略][guard] |
| disposition repair | 修复“未完成 Issue 没有有效执行/持久等待路径”；默认最多 **5**，延迟 `[0, 60s, 120s, 240s, 480s]`。同源状态 fingerprint 合并 Run 记录、持久计数与历史计数；达到上限升级，不无限追加。 | [常量][repair]、[实际调度与计数][repairhook] |

**所以，既不能说没有修复计数，也不能说统一默认 3 次。** `issue_recovery_actions` 明确存 `attemptCount/maxAttempts/fingerprint/retryPolicy`；这证明控制面恢复有持久状态，但 disposition repair 针对的是处置路径缺失，不是“每次测试红灯修一次”的业务修复循环。初始 Run + 2 次 continuation 可能是 3 个执行，不能混称 3 次修复。证据：[packages/db/src/schema/issue_recovery_actions.ts:13–32][counter]。

修复指导仍让 Agent 选择并执行：完成则 done，需审查则建立真实 reviewer path，依赖未解决则 blocked，有后续工作则建立显式 continuation。服务端恢复也能显式把源 Issue 写为 blocked 并挂 recovery action，所以“只有 Agent 能写 blocked”同样不准确。证据：[server/src/services/recovery/successful-run-handoff.ts:438–451][handoff]；[server/src/services/recovery/service.ts:3953–3973][block]。

**未确证范围**：未找到并验证一个跨所有 Adapter、围绕测试结果/验收语义、统一默认 3 次的产品级代码修复预算。这里不是用搜索空结果证明不存在，而是用已追踪的三类计数与调用链说明：现有机制各有不同对象、上限和触发条件，不能借其名称推导业务保证。

## 4. 预算、暂停、并发不是任务失败

- 预算服务可按 Agent / Project / Company 范围暂停；Agent 写 `status: paused, pauseReason: budget`，硬预算暂停路径还调用取消对应活跃运行的处理。invocation admission 返回明确 budget hard-stop / accounting-pending 阻止原因。证据：[server/src/services/budgets.ts:283–324][budget]；[server/src/services/budgets.ts:859–875][admit]。
- 并发满时，启动锁内计算 `maxConcurrentRuns - runningCount`，没有槽就不启动排队 Run；这不是自动把 Issue blocked/failed，也不是把 Agent 设 paused。证据：[server/src/services/heartbeat.ts:19933–19952][concurrent]。
- heartbeat 配置另有 daily run/cost 上限；定时 heartbeat 此处默认 `enabled: false, intervalSec: 0`。所以“平台会永久自动循环直到修好”不是合理默认。证据：[server/src/services/heartbeat.ts:16675–16705][policy]。

## 5. Wemux 应采用什么信号

以下是设计建议，不是宣称 Wemux 已实现：

1. **硬事实自动处理**：Worker 连接/执行租约、进程码与信号、超时、Adapter 结构化终态、明确的配额/认证/基础设施错误、预算、CAS/幂等与并发。连接失联先视为执行结果未知并核对，不能当作业务失败重复执行。
2. **测试采用结构化 Verification 结果**：保存命令、退出码、revision/workspace、日志与必需检查集合。必需测试红灯可阻止完成/审查通过，并触发明确授权的修复策略；不要靠 stdout 关键字，也不要让 Run 成功自动 done。
3. **无进展采用多信号、可解释等级**：静默时长、重复无新产物、无状态/依赖变化、只规划不执行分别记录；工具在运行/等待人/等待外部依赖应豁免。先告警或有限续跑，不能凭“有输出”证明有效推进。
4. **重试分账**：基础设施 retry、无进展 continuation、缺失处置修复、业务验收修复分别计数。使用 Task + 来源 Run + failure/evidence fingerprint 的持久幂等，设置预算、上限、退避、取消和升级对象。若产品选择业务修复默认 3 次，应明确这是我们的策略，而非 Paperclip 的统一默认。
5. **语义交给 Agent/人，写入交给控制面验证**：是否修对、测试是否足够、需求是否完成、真实 blocker 是什么，需要 Agent 给证据、必要时人/审查者判断；控制面校验完成条件和审查策略，确认写入成功后才显示 done。blocked 必须有依赖或负责人与解除动作；无新信息不反复唤醒或发相同评论。

## 固定源码链接

[outcome]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/heartbeat.ts#L25440-L25472
[process]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/adapters/process/execute.ts#L98-L135
[claude]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/packages/adapters/claude-local/src/server/execute.ts#L1151-L1269
[codex]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/packages/adapters/codex-local/src/server/execute.ts#L1538-L1547
[patch]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/routes/issues.ts#L13327-L13339
[status]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/issues.ts#L310-L338
[skill]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/skills/paperclip/SKILL.md#L209-L230
[dedup]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/skills/paperclip/SKILL.md#L107-L117
[live]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/run-liveness.ts#L321-L368
[evidence]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/run-liveness.ts#L193-L205
[cont]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/recovery/run-liveness-continuations.ts#L8-L15
[guard]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/recovery/run-liveness-continuations.ts#L106-L153
[conthook]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/heartbeat.ts#L25950-L25969
[exhaust]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/heartbeat.ts#L13190-L13227
[retry]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/heartbeat.ts#L846-L861
[retryhook]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/heartbeat.ts#L25909-L25943
[contract]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/heartbeat.ts#L1145-L1172
[retryguard]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/heartbeat.ts#L15375-L15423
[maxturn]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/heartbeat.ts#L928-L943
[maxpolicy]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/heartbeat.ts#L16929-L16955
[repair]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/recovery/disposition-repair.ts#L16-L19
[repairhook]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/recovery/service.ts#L3777-L3911
[counter]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/packages/db/src/schema/issue_recovery_actions.ts#L13-L32
[block]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/recovery/service.ts#L3953-L3973
[handoff]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/recovery/successful-run-handoff.ts#L438-L451
[watchtime]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/recovery/service.ts#L168-L170
[watch]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/modules/active-run-watchdog/domain/policy.ts#L19-L40
[watchscan]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/modules/active-run-watchdog/application/use-cases.ts#L241-L296
[inactivity]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/packages/adapters/codex-local/src/server/output-inactivity-monitor.ts#L3-L26
[inactivityresult]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/packages/adapters/codex-local/src/server/execute.ts#L1412-L1422
[throttleconst]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/issue-rewake-throttle.ts#L27-L40
[throttle]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/issue-rewake-throttle.ts#L108-L181
[self]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/routes/issues.ts#L16590-L16605
[budget]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/budgets.ts#L283-L324
[admit]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/budgets.ts#L859-L875
[concurrent]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/heartbeat.ts#L19933-L19952
[policy]: https://github.com/paperclipai/paperclip/blob/d6df12cef69fcaf2d2fe66a393168931d5b8b4e7/server/src/services/heartbeat.ts#L16675-L16705
