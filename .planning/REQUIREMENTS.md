# Requirements: Wemux Lite Web-next

**Defined:** 2026-10-06  
**Core Value:** 获权用户通过 Server 或独立 Worker，从 Task 安全发起对话与实施，完成可审查的协作闭环，并在桌面和手机端使用全部有效功能。

验收以 `.scratch/web-next-project-agent-platform/issues/` 原始票据全文和 `docs/specs/web-next-project-agent-platform.md` 为准；下列是可追踪摘要，不缩减任何原票标准。交接中的局部通过不等于整票通过。每项完成需实现、真实验证和记录证据；未经用户要求不自动提交。

## v1 Requirements

### 新版 Server 入口与核心工作流

- [ ] **NEXT-01**: 用户可在同实例 `/next/` 通过真实账号登录、查看获权项目、使用深链接/刷新/后退和可诊断失败态；桌面手机可用，Paperclip 来源及迁移盘点可追溯。（票01）阶段 1 候选本地矩阵全绿并获用户确认（2026-10-07，`docs/acceptance/web-next-phase1-candidate.md`）；真实 Google OAuth 外部门未过，整票未关门。
- [ ] **NEXT-02**: 用户可在新版自助管理账号、Team 邀请/成员与资源授权，并验证外部邮件/OAuth 和撤权边界。（票02）阶段 1 候选本地矩阵全绿并获用户确认（出件箱替代投递）；真实 Google OAuth 与真实 SMTP 外部门未过，整票未关门。
- [x] **NEXT-03**: 获权用户可管理 Project、Repository、Workspace Placement 与普通 Task，失败可定向重试，操作不误删外部文件。（票03）阶段 1 候选本地矩阵全绿并获用户确认（含历史删除终结、账号级隐藏与准备保护增补；证据见候选文档）。
- [x] **NEXT-04**: 用户能在固定 Task 下创建与复用 Session，可靠使用流式对话/审批/队列/停止/恢复，同 Session 模型切换只影响下一 Turn。（票04）八项有界行为经阶段 1 候选本地矩阵全绿并获用户确认；独立 Worker 宿主全流程按规划留 Phase 5（票13/14）。
- [ ] **NEXT-05**: Agent 可通过可信项目级 API 查询获权资源与 `task.sessions`；用户在 Team 专用 Task 下使用执行边界强制隔离的协调讨论，不能经任一写通道绕过。（票05）
- [ ] **NEXT-06**: 用户能对计划 revision 批准，并经授权幂等且一致地交接到含计划、验收和来源的实施 Task，讨论继续可用。（票06）
- [ ] **NEXT-07**: 用户可追踪 Run/取消竞态、显式提交成果，按项目/任务审查策略进入完成或多阶段审查，并从真实待办处理。（票07）阶段 1 候选本地矩阵全绿并获用户确认；真实外部渠道死信、独立视觉复审与真实付费运行时签收未过，整票未关门。
- [ ] **NEXT-08**: 现有有效 Runtime 以各自合适入口完成同一项目查询、交接、执行与报告流程，差异明示并用真实执行验证。（票08）

### 协作、资源与双宿主

- [ ] **NEXT-09**: 用户可按会话权限共享、访问画布及在同 Task 下固定 cursor Fork；撤权后列表、血缘、缓存与实时流同步过滤。（票09）
- [ ] **NEXT-10**: 获权实施用户可安全浏览/修改文件、看 Diff、使用终端及下载成果证据，协调模式不取得实施写权。（票10）
- [ ] **NEXT-11**: 管理员能管理 Worker、Agent/Model 能力与 Skill/Preset/Provider，区分配置、认证、分发与可执行状态。（票11）
- [ ] **NEXT-12**: 用户能按授权配置 Connector/Channel、审批外部写入、查看投递/死信并幂等重试，Secret 不泄漏。（票12）
- [ ] **NEXT-13**: 用户无需 Server 即可在独立 Worker 用本地鉴权管理本地 Task、Session 和结果；入群不自动上传本地记录。（票13）
- [ ] **NEXT-14**: 用户能配置 Worker 本地身份与 Agent，主动入/退集群并从失败中恢复，本地任务和凭据不被集群身份混用。（票14）

### 收口与发布

- [ ] **NEXT-15**: 新版全部有效功能逐操作迁移且跨页、桌面手机和全链路验收通过；旧根及旧 Worker 调用方转换被验证后才移除无 Task 等兼容业务旁路。（票15）
- [ ] **NEXT-16**: 操作者在 01–15 全部通过后固定候选版本，清点备份并成组重置自身应用数据/身份与传输状态，演练恢复、切根和删除旧版，再通过构建/测试/打包及真实双宿主验收。（票16）

## v2 Requirements

- **FUTURE-01**: 新增 Codex 等未在现有有效 Runtime 列表的执行适配；不作为新版切换前置条件。
- **FUTURE-02**: 未经逐项验收的额外企业连接器或未来功能；不以迁移宣称已交付。

## Out of Scope

| Feature | Reason |
| --- | --- |
| 付费 Runtime、伪造审批 | 当前明确禁止；真实付费认证需独立授权 |
| 未知归属数据的清理 | 必须确认归属和影响范围；不可猜测生产身份 |
| 01–15 未验收前删除旧版或切根 | 违背安全切换门槛 |
| 05-F2 环境策略擅自选 A/B | 必须由用户决定 |

## Traceability

| Requirement | Phase | Status |
| --- | --- | --- |
| NEXT-01 | Phase 1 | 本地候选全绿并获用户确认（2026-10-07）；真实 Google OAuth 外部门开放 |
| NEXT-02 | Phase 1 | 本地候选全绿并获用户确认（2026-10-07）；真实 Google OAuth/SMTP 外部门开放 |
| NEXT-03 | Phase 1 | Complete（2026-10-07 候选签收，证据：web-next-phase1-candidate.md） |
| NEXT-04 | Phase 1 | Complete（八项有界+候选门；独立宿主留 Phase 5） |
| NEXT-05 | Phase 2 | In Progress, 受控切片已交付（`web-next-phase2-controlled-slice.md`：模型/入口禁用态/查询缺口 a+b/写通道矩阵），#52 决策门与隔离资格门未过 |
| NEXT-06 | Phase 3 | Pending |
| NEXT-07 | Phase 1 | 本地候选全绿并获用户确认（2026-10-07）；外部死信/视觉复审/付费运行时门开放 |
| NEXT-08 | Phase 3 | Pending |
| NEXT-09 | Phase 4 | Pending, 局部切片已有证据 |
| NEXT-10 | Phase 4 | Pending, 写通道关闭等局部切片已验证 |
| NEXT-11 | Phase 5 | Pending |
| NEXT-12 | Phase 4 | Pending |
| NEXT-13 | Phase 5 | Pending |
| NEXT-14 | Phase 5 | Pending |
| NEXT-15 | Phase 6 | Pending |
| NEXT-16 | Phase 7 | Pending |

**Coverage:** v1 requirements: 16; mapped: 16 across 7 phases; unmapped: 0. 阶段并非原票号，具体阻塞/验收依赖以 `.planning/ROADMAP.md` 和各票为准。

---
*Requirements defined: 2026-10-06*
*Last updated: 2026-10-07 Phase 1 候选签收（用户确认 m04774）：NEXT-03/04 完成，NEXT-01/02/07 本地全绿、外部门开放*
