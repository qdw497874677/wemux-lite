# Web-next 阶段 1 候选验收记录（2026-10-07）

状态：**本地可验证矩阵全绿；外部门保持 blocked。**用户于 2026-10-07 确认接受本矩阵与 blocked 清单（“接受”），据此：NEXT-03、NEXT-04 关门；NEXT-01/02/07 保持开放（真实 Google OAuth、真实 SMTP、真实外部渠道死信、真实移动设备、独立视觉复审、独立安全复审、真实付费运行时签收）。本文件由 01-11 计划产出，是阶段 1 的唯一候选验收汇总，取代此前分散在各票 SUMMARY 中的进度叙述。

## 候选身份

- Git HEAD：`93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`；共享工作树含约 1033 个未提交变更（含本阶段全部实现与测试，另混有并行会话产物），未做选择性提交。
- 源指纹（sha256 of sorted sha256s，截取 16 位）：`apps/server/src 1258eab9100faf39`、`apps/worker/src 96836fb3a860dda2`、`apps/web-next/src 8145bf37a6c0ffbe`、`apps/web-next/tests ea10a95860ee3e23`、`apps/e2e 74f77d23852754f5`、`packages 8f252902edee7c87`。
- 运行时：Node v26.5.1；Next 静态构建 `/tmp/wemux-next-dist-0110`；Worker CLI 拷贝 `/tmp/wemux-test-worker-0110/dist/cli.js`（node_modules 符号链接仓库根）；Chromium `chromium-1228/chrome-linux64/chrome` + playwright-core 1.61.0。

## 同候选本地矩阵（全部通过）

- `@wemux/server`：917/917（tsx + node:test）。
- `@wemux/web-next`：`test:prepared` 167/167（含受控 Chromium 桌面/手机双端浏览器测试）。
- `@wemux/worker` 与 `packages/*`：构建与测试通过（候选冻结时同源复跑）。
- 真实 Worker CLI + Test Agent + 浏览器 e2e（7 脚本，全部 EXIT=0）：`next-worker-task-run`（Run 复用/取消/暂停/失败/丢失完成响应 requestId 重放）、`next-multi-stage-review`、`next-task-session`、`next-conversation`、`next-attention-review`、`next-worker-human-review`、`next-attention-sources`。
- 证据副本：`.scratch/web-next-project-agent-platform/evidence/phase1-01/0111-candidate-rerun/`（task-run 多镜头 checks 清单 JSON、多阶段/任务运行两份脚本日志、其余各脚本 checks/result JSON 与全量 prepared 日志；multi-stage 脚本 finally 清理临时目录，仅留脚本日志）。

## 矩阵中的契约对齐（本轮修订测试，非生产代码变更）

1. `apps/web-next/tests/session-effect-authorization.browser.mts`：五个写入端点现统一 403 `write_channel_closed`（先于资源授权），矩阵改为全 403/匿名 401；读通道仍按授权分级验证。
2. `apps/web-next/tests/project-management.browser.mts`：Task 下 Session 创建需 `requestId`（幂等契约）。
3. `apps/e2e/next-task-session-browser.mjs`：`set_model` 准入不再乐观改绑定，补充模拟 Worker `model.changed` Journal 事件后才断言模型切换。
4. `apps/e2e/next-conversation-browser.mjs`：待决审批移至未结束 Turn（`turn.finished` 使本轮审批过期），文案对齐“尚未处理的审批：1。”。
5. `apps/e2e/next-attention-review-browser.mjs`、`next-worker-human-review-browser.mjs`：非管理员界面不再请求渠道死信页（仍管理员专属），错误记账去掉相应 403 期望；活动 payload 增加 `stageIndex/stageCount`（多级审查）。

## 各票验收门（票 → 状态）

- 01-01 入口/登录/授权过期：本地 PASS；真实 Google OAuth 门 BLOCKED（无凭据）。
- 01-02 账号/团队/项目：本地 PASS；真实邮件投递（SMTP）门 BLOCKED（仅出件箱）。
- 01-03 任务/工作区：本地 PASS（含 CAS/幂等/授权矩阵）。
- 01-04 会话/对话：本地 PASS（Journal 投影、审批过期语义）。
- 07 票（Run 完成/审查/注意源）：本地 PASS（真实 Worker CLI + Test Agent 桌面/手机）；独立视觉复审 BLOCKED（截图未逐张人工审查）；真实外部渠道死信 BLOCKED。
- 通用外部门：真实移动设备（当前仅 Chromium 手机仿真）、独立安全复审、真实付费 Agent 运行时签收：BLOCKED。

## 人工检查点

`checkpoint:human-verify` 已于 2026-10-07 通过：用户确认接受同候选矩阵与 blocked 清单。`REQUIREMENTS.md`/`ROADMAP.md` 已据此更新（NEXT-03/04 完成；01/02/07 开放）。真实外部门满足前，阶段 1 不标完成、不进入阶段 2。
