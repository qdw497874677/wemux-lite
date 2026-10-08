# Phase 2: 受限协调与项目 Agent API - Context

**Gathered:** 2026-10-08
**Status:** Ready for planning

<domain>
## Phase Boundary

交付 Web-next 票05（项目级 Agent API 与协调聊天）的受控切片：Team 级协调专用 Task/Session 数据模型与 Web UI（入口按隔离资格门裁决禁用）、项目 Agent API 查询面两处已知缺口补全（共享 Task 投影、真实 Worker 补传配对观测）、协调模式全写入通道系统性复核矩阵。不开放真实协调执行；票05 整票保持 in-progress，Ticket06 前置门不解除。

</domain>

<decisions>
## Implementation Decisions

### 隔离资格门岔路（#52 / 05-F2，用户决策 1A）
- **D-01:** 选择 **A：协调入口保持关闭**。本阶段交付协调数据模型与查询面完整化，但真实协调会话入口由隔离资格门裁决置为不可用；票05 保持 in-progress，Ticket06 前置门不解除 — **Reversibility:** reversible — 环境变更（bubblewrap/userns/Landlock/独立账号/独立宿主）到位后按原探针集重跑资格门即可解除，不涉及数据迁移
- **D-02:** 不选择 B（显式风险接受开放）：不书面接受"Runtime 可读 Worker 凭据与整个仓库、可对外发网络请求"的风险；也不在本阶段做环境变更（选项 E 留给用户未来单独决定）

### 协调模型先行深度（用户决策 2a）
- **D-03:** 完整实现 Team 级协调专用 Task/Session 模型 **并渲染 Web UI**（Team 范围入口不要求先选 Project），但入口在资格门 FAIL 时呈现**可诊断的不可用说明**（指向资格门证据与解除条件），不是隐藏不渲染 — **Reversibility:** costly — 入口开放时 UI 复用，但禁用态文案与裁决接线需要跨 Server/Web 维护
- **D-04:** 协调 Task 复用键 **Team + 用户 + Worker + Agent**（Model 不参与），首次发送/上传自动创建，单纯浏览不造空任务；active/waiting 是处理/等待表达而非人工审查状态；重开上下文在原 Task 下新建 Session，不能换绑

### 查询面缺口范围（用户决策 3：确认全量纳入）
- **D-05:** 按票05原验收全量补两处缺口：(a) 共享 Task 投影——权威计划版本与审查要求随 Task 查询返回；(b) 真实 Worker 断连/恢复补传时，浏览器与 Agent 工具（CLI/MCP）对同一 Session 的 freshness/gap→synced 状态**配对观测**——补齐 2026-10-05 复审（914bc2cd）BLOCK 的三项全勾选声明

### 写入通道复核（用户决策 4：纳入）
- **D-06:** 本阶段产出协调模式**全写入通道系统性复核矩阵**：文件、终端、连接器、外部投递、Web API、Worker 直接帧写面（05-H 已封部分）逐项列出拒绝证据或明确缺口；不能可靠限制的通道明确标记，任何缺口不得静默放过 — **Reversibility:** reversible — 矩阵是证据产物，随资格门重跑更新

### Claude's Discretion
- 协调 Task 自动创建的具体触发实现（首次发送 vs 首次上传的具体钩子位置）
- 复核矩阵的文档位置与结构（建议 `.scratch/web-next-project-agent-platform/evidence/` 或 `docs/acceptance/`，按现有惯例）

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 票据与验收
- `.scratch/web-next-project-agent-platform/issues/05-project-agent-api-coordination.md` — 票05 验收标准（10 项勾选框全部未勾）与执行约定
- `docs/acceptance/web-next-project-agent-api-increment.md` — 已交付查询切片、复审记录、剩余待实施清单（Team 协调 Task、受限 Runtime、全部写入通道）
- `.scratch/web-next-project-agent-platform/evidence/ticket-05-runtime-isolation-gate.md` — 资格门 FAIL 判定、可强制/不可强制清单、§五环境变更选项、§六 A/B 岔路原始定义
- `docs/specs/web-next-project-agent-platform.md` — 产品规格：协调聊天原则（行 16–24）、里程碑划分
- `.planning/REQUIREMENTS.md` — NEXT-05 验收与"决策不可代选"清单（05-F2 行）
- `.planning/phases/01-existing-core-closure/01-CONTEXT.md` — 阶段 1 决策边界（明确把 05-F2 留给阶段 2）

### 设计文档
- `docs/design/worker-web-workbench.md` — 双宿主复用设计
- `CONTEXT.md`（仓库根）— 领域术语（Worker/Agent/Task/Session 复用键等）

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/server/src/capability/*`（CapabilityService 等）— 已有项目级查询 API 的统一应用服务，协调能力面应扩展而非平新建
- `apps/web-next/src/app/task-runs/TaskRuns.tsx` — Run/审查 UI 模式，协调 Task UI 可参照其数据获取与错误呈现
- `apps/e2e/next-worker-*.mjs` — 真实 Worker CLI + Test Agent + Chromium 双端 e2e 骨架（7 个脚本），配对观测测试可扩展

### Established Patterns
- 写操作 `requestId` 幂等 + CAS 乐观并发；能力 Token 签名 `actorUserId` + `actorAuthVersion`
- 先按请求用户可见性过滤再分页；分页上限与稳定 ID 排序
- 真实浏览器验收优先于源码契约测试；证据入 `.scratch/.../evidence/`

### Integration Points
- Worker 连接器 operation 门（`apps/worker/src/connector/*`）— 协调身份的 `operation ∈ allowedTools` 检查
- Server SSE/投影层 — 协调 Task 的 active/waiting 生命周期投影

</code_context>

<specifics>
## Specific Ideas

无特定参考实现；协调入口禁用态要能引导用户看到资格门证据与解除条件（环境变更选项），不是干巴巴的"不可用"。

</specifics>

<deferred>
## Deferred Ideas

- 环境变更重跑资格门（选项 E：bubblewrap/firejail/protest、userns、Landlock、独立低权限账号+出口防火墙、独立宿主机）——用户未来单独决定，不属于本阶段
- 风险接受开放（选项 B）——已明确不选，除非用户未来书面撤销
- Ticket06 计划交接、正式派发——前置门不解除，不开始

</deferred>
