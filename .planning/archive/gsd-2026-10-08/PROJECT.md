# Wemux Lite Web-next 项目与 Agent 协作平台

## What This Is

Wemux Lite 是自托管的 AI Agent 集群管理与协作平台，Server 管理 Worker，Worker 执行 Agent；独立 Worker 也有自己的 Web/API 和本地身份。本项目在同实例 `/next/` 基于固定来源的 Paperclip 参考重建前端，并交付项目级 Agent API、Task 绑定会话、Team 协调与双宿主完整工作台；迁移全部现有有效功能后才切换根入口。

## Core Value

用户能在获权的 Server 或独立 Worker 中，从 Task 发起可靠且可审查的 Agent 对话与实施，安全完成计划交接，并在桌面和手机端连续使用全部有效功能。

## Requirements

### Validated

现有 Server、Worker、账号授权、任务/会话和部分新版纵向切片有局部自动化与人工证据；**本规划中的 16 张整票没有一张完成候选版本的全口径验收**。不把已有入口、局部测试或 Ticket 04 的有界关门记作本项目整票已验证。

### Active

- [ ] 按 `.scratch/web-next-project-agent-platform/issues/01..16` 的原始票据及验收顺序完成 16 张票，逐票记录可复查证据。
- [ ] 修复妨碍后续验收的安全与全量回归阻塞，不为了凑绿削弱断言。
- [ ] 在真实 Server/Worker、现有有效 Runtime、桌面和手机上验收新版全部有效功能和双宿主。
- [ ] 先通过全功能与候选门，再安全重置本项目应用数据、切换根入口并移除旧前端。

### Out of Scope

- 新增 Codex 等未纳入切换门槛的 Runtime — 不是此次迁移既有能力的条件。
- 付费 Runtime 调用、伪造审批、归属不明数据清理 — 违反本轮授权边界。
- 未经确认直接决定 05-F2 隔离环境 A/B 策略 — 用户决策尚未给出。
- 提前删除旧前端、旧 Worker 调用方或进行生产数据重置 — 必须先满足各自独立门槛。

## Context

- 交接快照：`/tmp/wemux-mini-web-next-session-handoff-2026-10-06.md`；早期范围：`/tmp/wemux-mini-web-next-tickets-handoff.md`；权威规格：`docs/specs/web-next-project-agent-platform.md`、`docs/specs/web-next-project-agent-prd.md`、ADR 0006/0007；逐票准则：`.scratch/web-next-project-agent-platform/issues/`。历史 `docs/roadmap.md` 中旧的“无 Task 直接对话”等描述不覆盖新方向。
- 2026-10-06 快照：Ticket 01/03/05/07 部分进行；02 本地验证仍有外部门；04 有界会话切片完成但不代表全链路验收；其余未整票验收。具体状态以原交接与最新证据为准，不能从 issue `ready-for-agent` 推断无依赖。
- 工作树已有约 341 项未提交变更；不 reset/clean，不自行 stage/commit/push。`.planning/` 仅记录规划，**不是**新的产品项目目录或独立部署实例。
- 当前安全及验收阻塞：#58 SSE 原始凭据重验遗留 6 处未经复审改动；#57 deleted Task SSE 返回码待裁定；#60 server 全量回归从 71 个失败起已修部分、仍需收口并完整重跑；#52 隔离环境需要用户 A/B 决策。详情及既有不变式见交接文档 §2–§6，后续开工须重新核对实际状态。

## Constraints

- **产品**：每个 Session 固定绑定 Task；Team 协调专用 Task 与 Project 实施 Task 分离；模型切换只影响下一 Turn；Run 成功不自动标记任务完成；审批绑定计划 revision。
- **安全**：执行边界强制协调只读，不信任 Agent 自报身份；按项目/Worker/Session 权限交集过滤，撤权后拒绝；沿用 Ticket10 写通道关闭受保护裁定，不绕过平台鉴权。
- **迁移**：同实例根旧版与 `/next/` 共存，共用 Server/账号/数据；旧版历史回归不作为新版门槛，但移除兼容旁路前必须验证旧调用方合法 Task 会话转换。
- **验证**：真实浏览器/真实 Worker/公开 API 及桌面手机操作，模拟和源码存在不能代替真实验收；一票一验收，阻塞如实记录。
- **操作**：仅使用已确认归属的测试数据；禁止付费 Runtime、凭据暴露与未知数据清理。禁止自动 Git 提交；构建避免根全量并发写产物。

## Key Decisions

| Decision | Rationale | Outcome |
| --- | --- | --- |
| GSD 以 7 个成果阶段覆盖 16 张原票，Phase 1 集中收尾 01/02/03/04/07 | 用户确认把已做一半的主链路整合收尾；既有切片不倒填完成，原票逐一保留验收门，其余阶段按安全资格门和产品成果拆分 | — 待逐阶段验收 |
| GSD 配置禁用自动提交、自动推进和并行执行 | 工作树大量在制变更且有共享路径及用户未要求提交 | ✓ 已设置 |
| GSD 不自动触发付费研究或实施 | 交接已给出需求且用户禁止付费 Runtime，本轮只初始化规划 | ✓ 已设置 |
| 数据重置与删除旧版分门槛 | 可以先清已确认归属的测试数据，不能以此提前切根或删旧前端 | — 待 Ticket 16 |

## Evolution

此文档在每阶段转换和里程碑结束时核对：把真实通过验收的要求移到 Validated，把不再成立的目标注明原因移到 Out of Scope；更新决策与最新工作树状态。不能只依据任务状态或页面入口勾选完成。

---
*Last updated: 2026-10-06 after user-approved consolidation into seven phases*
