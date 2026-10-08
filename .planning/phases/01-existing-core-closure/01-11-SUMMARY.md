---
phase: 01-existing-core-closure
plan: '11'
type: summary
created: 2026-10-07
status: completed
human_checkpoint: approved-2026-10-07
depends_on: ['01-01', '01-02', '01-03', '01-04', '01-10']
---

# 01-11 候选冻结与集中验收

状态：**已完成。**用户 2026-10-07 确认接受本地矩阵与 blocked 清单；`checkpoint:human-verify` 通过。据此 NEXT-03/04 关门，NEXT-01/02/07 保持开放（外部门）。完整记录见 `docs/acceptance/web-next-phase1-candidate.md`。

## 已完成

- 候选冻结：HEAD `93c9f67` + 六个源目录指纹 + Node/Chromium/构建产物身份（见候选文档）。
- 同候选复跑全部通过：server 917/917、web-next prepared 167/167、worker/packages、七个真实 Worker CLI + Test Agent + Chromium 双端 e2e（task-run/multi-stage-review/task-session/conversation/attention-review/worker-human-review/attention-sources）。
- 复跑期间将五处浏览器测试期望对齐当前契约（write_channel_closed 403 矩阵、Session requestId、set_model Journal 确认、turn.finished 审批过期、非管理员不请求死信页、活动 payload stage 字段）；未改生产代码。
- 证据副本：`.scratch/web-next-project-agent-platform/evidence/phase1-01/0111-candidate-rerun/`（multi-stage 脚本 finally 清理临时目录，仅脚本日志；其余含 checks/result JSON）。
- 人工签收：用户 2026-10-07 确认；更新 `REQUIREMENTS.md`（NEXT-03/04 完成，01/02/07 外部门开放）与 `ROADMAP.md`（11 计划勾选、阶段保持 OPEN）。

## 未完成（仍开放，阶段 1 不标完成）

- 真实 Google OAuth、真实 SMTP、真实外部渠道死信、真实移动设备、独立视觉/安全复审、真实付费运行时签收（对应 NEXT-01/02/07）。
