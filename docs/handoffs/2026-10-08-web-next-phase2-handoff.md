# 交接文档：Wemux Lite Web-next（阶段 2 收尾与后续）

**生成**：2026-10-08 ｜ **仓库**：`/opt/data/profiles/hacker/workspace/project/wemux-mini` ｜ **远端**：`git@github.com:qdw497874677/wemux-lite.git` ｜ **分支**：`main` ｜ **会话结束时 HEAD**：`272293e`（附带本交接提交）；本会话本地一度领先 `origin/main` 42 个提交、0 落后，本次已推送。

**接手第一步**：先读仓库根 `AGENTS.md`（沙箱陷阱、运行命令、Web 端硬约束、领域速记），再读 `.planning/ROADMAP.md` 与 `.planning/REQUIREMENTS.md` 确认阶段状态。本文件只记录"当前状态 + 未决项 + 操作口径"，不复制规划、规格与证据正文（按路径引用）。

## 1. 本会话的目标与演化（按时间顺序）

1. 依据 `/tmp/wemux-mini-web-next-session-handoff-2026-10-06.md` 建立 GSD 项目（`.planning/`，7 阶段路线图）。
2. 用户："执行阶段1" → 阶段 1 的 11 张计划全部完成，本地候选矩阵全绿并获用户确认。
3. 用户："提交变更。然后进行阶段2规划" → 阶段 2 六张计划写成并复核。
4. 用户："执行全部阶段2" → 02-01…02-06 逐张执行；期间 D-04 身份合同、02-02 禁用态 UX、02-05 矩阵、02-06 口径四项人审逐步到达。
5. 用户："都接受" → 三项 checkpoint 一并签收（生效范围含 02-05 的缺口登记方式）。
6. 用户："A" → 产出隔离环境方案决策简报（待用户决定，未预选）。
7. 本次：交接文档入库 + 提交 + 推送。

## 2. 当前真实状态（不得改写、不得夸大）

- **阶段 1（存量主链路 01/02/03/04/07）**：本地候选全绿、用户已确认（2026-10-07）；`NEXT-03/04` 已关门，`NEXT-01/02/07` 等待外部门（真实 OAuth/SMTP、外部死信、视觉复审、付费运行时）。**阶段保持 OPEN**，详见 `.planning/ROADMAP.md`。
- **阶段 2（受限协调与项目 Agent API）**：`02-01`…`02-06` 六张计划全部完成并在同一候选重跑通过（server 930/930、worker 440 通过 4 skip、web 297/297、web-next 168/168、typecheck 三工作区、三个 e2e 退出码 0）。三项人审 checkpoint 已签收。**阶段保持 OPEN**，唯一原因是协调执行资格门 FAIL。总账：`docs/acceptance/web-next-phase2-controlled-slice.md`。
- **口径（签收后仍不变）**：票 05 未完成；`NEXT-05` 未勾选；Ticket06 前置门不解除；协调入口保持禁用（`GET /api/teams/:id/coordination/availability` → `{ status: 'disabled', gate.verdict: 'FAIL' }`）；不构成风险接受（`02-CONTEXT.md` D-02 未选）；资格门环境方案未预选。

## 3. 唯一阻塞与待用户决定的事

隔离资格门判定 FAIL（`apps`/OS 级隔离与网络出口收敛均不可用）。决策简报：`docs/design/coordination-isolation-options.md`（五个环境方案 O1…O5 与 §六 A/B 岔路、决策后动作、三个待答问题）。**用户的三个问题仍未回答**：

1. 走哪条路：维持 A（保持关闭）/ 选 B（书面风险接受后开受限入口）/ 做环境变更（O1…O5 中哪几项）。
2. 环境变更由谁执行；是否需要起草交给宿主/部署方的变更要求清单（含探针与验收口径）。
3. 若选 B：书面风险接受范围、环境边界、可读目录范围。

依赖关系提醒：Phase 3 的票 06 依赖票 05，因此资格门未过时 Phase 3 无法真正推进（`ROADMAP.md` 亦然）。

## 4. 已登记的缺口（不因阶段推进消失）

- **持久 `gap` 缓存状态不可达**（02-04 如实 blocked）：协议约束与替代证据见 `docs/acceptance/web-next-reconnect-pairing.md` 与 `.scratch/web-next-project-agent-platform/evidence/02-04/`。
- **写通道缺口两项**（`docs/acceptance/coordination-write-channel-matrix.md` 两行 `documented-gap`）：Worker 工具网关不校验 `allowedTools`/binding；Worker 不校验命令帧授权（实测真实持久帧被接受）。签收时已确认：缺口各回责任票，**不在阶段 2 顺修**。
- **资格门缺口**：见第 3 节。
- **`project.list` 仍只允许来源 Project**，不宣称跨项目发现（不在票 05 切片范围）。

## 5. 提交索引

阶段 2 切片提交（自旧到新）：`79b8901`（02-01）、`5404504`（02-02）、`bd7cf81`（02-03）、`5e9cc8f`（02-04）、`54585bc`（02-05）、`e64a16f`（02-06 总账）、`81c9f25`（AGENTS.md 沙箱 Chromium 路径）、`7f328c5`（三项 checkpoint 签收）、`272293e`（隔离决策简报）+ 本交接提交。阶段 1 提交用 `git log` 查阅，不在此枚举。

## 6. 复现口径（命令与环境，细节不重复 AGENTS.md）

- 包与类型：`npm run build:packages`；`npm run typecheck --workspace @wemux/{server,worker,web-next}`。
- 测试：`npm test --workspace @wemux/{server,worker,web}`；web-next 用 `test:prepared`（需 `PLAYWRIGHT_CORE_PATH` 与 `PLAYWRIGHT_CHROMIUM_PATH`，不带时浏览器用例按设计报配置错）。
- 阶段 2 三个验收脚本（均需 `WEMUX_NEXT_TEST_DIST` 指向 `/tmp/` 下一次性 dist 拷贝，脚本自身不构建）：
  - `node --import tsx apps/e2e/next-coordination-entry-browser.mjs`（入口禁用态，桌面 + 移动）
  - `node --import tsx apps/e2e/next-worker-reconnect-pairing.mjs`（断连重放配对；稳定观测量 `stalledAt 9`、`withheld [10,136]`、`gapStatesSeen 0`）
  - `node --import tsx apps/e2e/coordination-write-channel-probes.mjs`（六类写入通道；退出码非 0 或出现 `unhandled` 即门未过）
- GSD 校验：`node /opt/data/.pi/agent/gsd-core/bin/gsd-tools.cjs validate consistency --raw`（应输出 `passed`）。
- 主模型现可直接用 `read` 读 PNG 截图（用户 2026-10-08 确认）；`vision_analyze` 在本机不可用（配置的视觉模型不存在）。

## 7. GSD 用法要点（本会话踩过的）

- `gsd_invoke` 只认 GSD 插件自身的命令族；调用 `plan` / `help` 会返回 `sdk_unknown_command`。**规划由 workflow markdown 驱动**：`/opt/data/.pi/agent/gsd-core/workflows/`（`discuss-phase.md`、`plan-phase.md`、`execute-phase.md`、`verify-work.md`、`new-milestone.md` 等）。
- 追踪文件：`.planning/REQUIREMENTS.md`、`.planning/ROADMAP.md`、`.planning/phases/0X-*/`（`0X-0Y-PLAN.md` + `0X-0Y-SUMMARY.md`，SUMMARY 内含 checkpoint 段）。
- 阶段编号与票据映射、阶段关闭要求（整票验收而非局部测试）见 `ROADMAP.md` 开头段落，勿自行重排。

## 8. 用户偏好（供下个会话对齐）

- 中文交流；要"结论 + 证据路径"，不要过程复述。
- 明确区分已实现 / 已验证 / 未完成；**禁止把受控切片说成整票完成**。
- 决策必须由用户拍板（环境方案、风险接受、发布口径）；不代选。
- 不允许调用付费模型或真实外部运行时；验收用确定性 Test Agent。
- 要求改动入库：`git add` 指定文件后 commit；本次明确要求 `git push`。

## 9. 下一步可选动作（依用户选择）

- **选 B**：先修两项写通道缺口票（它们无条件该修），再按 B 条件开放受限入口，界面与文档必须写明"未隔离"。
- **选环境变更**：由用户/宿主方实施 O1…O5，再按 gate 证据 §二/§三探针集 + 上述三脚本重跑，逐项给退出码；门过后解除 Ticket06 前置门、重跑矩阵、落缺口票，票 05 才具备整票验收条件。
- **维持 A**：阶段 2 保持 OPEN；转做不依赖协调 Runtime 的独立余量（如票 11/13），但必须先做依赖与差异核对，且不得越过各阶段整票验收门。

## 10. 红线

- 不勾 `NEXT-05`、不宣告票 05 完成、不开放协调入口、不把受控切片表述为"已隔离"。
- 不提交 `data/`、`.scratch/`、`artifacts/`、`dist/`、凭据与密钥；原始证据留 `.scratch`，脱敏摘要入 `docs/acceptance/`。
- 不得用提示词（"请勿改文件"）冒充执行边界；不得伪造隔离或门禁验证结果。
- 共享工作树单写者：`parallelization: false`，避免并行构建写入 `artifacts/` 与 `apps/web/dist`。

## Suggested skills（下个会话建议按需调用）

- `tdd`（`/opt/data/.agents/skills/tdd/SKILL.md`）：实现两项写通道缺口（Worker 工具网关 `allowedTools`/binding 校验、命令帧授权审计）时先写测试。
- `code-review`（`/opt/data/.agents/skills/code-review/SKILL.md`）：对缺口修复或下一阶段切片做 Standards/Spec 双轴复查。
- `research`（`/opt/data/.agents/skills/research/SKILL.md`）：若需外部事实核实（bubblewrap/firejail 隔离能力、Landlock 内核要求、seccomp 策略来源）。
- `grilling`（`/opt/data/.agents/skills/grilling/SKILL.md`）：在用户选 B（风险接受）前压力测试该决定。
- `domain-modeling`（`/opt/data/.agents/skills/domain-modeling/SKILL.md`）：若需把协调 Task/Session 术语固化进仓库根 `CONTEXT.md`。
- `design-taste-frontend`（仓库内 `.agents/skills/design-taste-frontend/SKILL.md`）：仅当协调入口 UI 真正开放或重做时使用。
- GSD 规划/执行流程：按第 7 节的 workflow markdown 驱动，不必自造流程。