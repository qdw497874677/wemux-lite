---
phase: 01-existing-core-closure
plan: '10'
type: summary
created: 2026-10-07
status: locally-verified
depends_on: ['01-09']
---

# 01-10 真实来源待办与双端回访

状态：**本计划可本地验证部分完成；逐图人工视觉审查与外部渠道死信门保持 OPEN，票 07 继续 OPEN。**分层证据在 `docs/acceptance/web-next-task-run-increment.md`（末节 2026-10-07 真实来源待办与双端回访）。

## 已完成

- 新验收脚本 `apps/e2e/next-attention-sources-browser.mjs`：真实 Worker CLI 子进程（受控 home + `register`/`start`）+ 确定性 Test Agent + Next Chromium 桌面/手机双端。退出码 0、4 条 checks、`errors=[]`；证据 `/tmp/wemux-next-attention-sources-YEVpmc/`，checks.json 副本入 `.scratch/web-next-project-agent-platform/evidence/phase1-01/0110-attention-sources/`。
- 真实 approval 来源：项目策略 `human`（首 Run 前设置，launch 冻结）→ 真实成功 Run → `POST /human-review-submission`（runId+summary+evidence）；真实 run_problem 来源：manager（持 `use` Worker Grant）浏览器启动 `[test-agent:fail]` 真实失败 Run。
- 双端回访：待办中心列表 → 深链回任务页正确 Run/决定面；run_problem 带 `?run=` 且显示 `故障：agent-error：Test Agent injected failure`；approval 到“批准并完成”。
- 权限与空态：manager 见自身两类来源；渠道死信区域明示仅实例管理员；管理员（提交者）/outsider 空态且不泄漏他人任务标题；`channel_dead_letter` 页 API 管理员 200、outsider 403。
- 失败注入：`/api/attention/pages?kind=approval` abort 后 alert 且不误显空态，重试恢复；唯一注入窗口豁免 `ERR_FAILED`，其余 console/pageerror/≥400 全零。
- 回归：`@wemux/server` 917/917；`@wemux/web-next` 带 Chromium 167/167、typecheck 0；受控 Worker 优雅退出。
- 边界核实：`attention-service.ts:30-37` 拒绝 `task_assignment` 属票 07 范围边界，保留不改；协调计划批准/工具审批为后续票集成，仅说明边界。

## 未完成（诚实门）

- 16 张截图仅确认生成与断言文本，未逐张人工视觉审查（当前会话无可用图像模型；`vision_analyze` 未配置视觉模型）。
- 无真实外部渠道（Feishu/Webhook）死信条目的产生与导航验证；仅有授权与空态。
- 票 07 第 6/8 项整票矩阵（全来源、Agent 审查决策面）仍 OPEN。
