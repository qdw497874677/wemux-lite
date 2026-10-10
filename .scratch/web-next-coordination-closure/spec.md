# Team 协调聊天贯通（NEXT-05）

Status: ready-for-agent

## Problem Statement

Team 协调 Task 的领域模型及查询能力已部分实现，但真实入口仍不可用：`GET /api/teams/:id/coordination/availability` 固定返回禁用；`POST /api/teams/:id/coordination/sessions` 在旧安全门后仍是 501；Web 仅显示诊断卡，没有创建、发送或继续对话的路径。此前把正常聊天绑定到隔离资格门，导致需求无法交付。

用户最新决定：协调 Agent 如普通 Pi Agent 一样使用，**不对协调身份额外限制文件、改代码、终端或联网**；将隔离作为以后独立的安全能力。此决定取代原 spec 的 L1 作用域、六类写通道全部拒绝、书面残余风险接受和隔离门开关要求，见 [ADR 0008](../../docs/adr/0008-coordination-chat-ordinary-runtime-permissions.md)。历史 FAIL、探针和局部实现仍是真实历史，不改写为通过。

## Solution

Team 成员在 Web 选择获权 Worker/Agent/Workspace，从首次发送自动创建或复用按 Team + 用户 + Worker + Agent 键控的协调 Task，在其下创建/复用 Session 并发送消息；后续可恢复对话，在原 Task 下重开 Session，流式查看结果并使用既有的停止、审批与模型能力。打开页面不创建 Task。正常 Task 归属、用户/Team/Worker/Workspace 授权、各工具自己的授权及既有审批规则继续执行；知道 Team/Task ID 不赋予别人的 Session 或 Project 数据权限。

协调会话可在普通 Runtime 具备的范围内读写文件、运行终端及联网；这些能力不自动赋予平台跨 Project 管理、任务派发、任务完成/取消或跳过审批权。创建实施 Task、按需批准、交接及项目管理工具由[项目管理 spec](../web-next-plan-handoff/spec.md)按操作级授权另行交付。当前 Server 对协调 grant 的额外只读策略及 Worker 对协调会话环境的特殊收口须与用户决定对齐，不得仅解开 UI 而留下不一致的执行行为。

## Implementation Decisions

- 复用已有协调 Task ID、Team 成员校验及 `(teamId, ownerId, workerId, agentKey)` 复用键；Model 不参与 Task 复用。首次发送/上传才创建 Task，失败不留下孤儿 Session/命令；同 requestId 幂等、不同请求的并发创建收敛。
- Session 始终绑定协调 Task 与选定 Worker/Workspace/Agent，选用真实已就绪的 Workspace Placement，权限在 Server 事务边界校验，不能凭客户端自报 owner/Team/Worker。Team 业务归属不等于 Workspace 的 Project 访问权；查询每个 Project 仍需独立鉴权。不同 Worker 不隐式迁移文件或会话。
- UI 在 `/next/` 团队页提供可选择执行环境、发送与对话恢复入口；仅展示当前用户可用资源和自己的协调历史，失败可重试且不得泄漏别的 Team/Session。沿用现有对话与审批组件，桌面/手机均可用；同 Session 模型切换仅对下一 Turn 生效。
- 旧静态安全资格门从协调功能路径移除，**只在创建/发送/恢复真实可用并通过授权负例后**才能把 availability 标为 enabled。绝不以把 FAIL 常量改为 PASS 或 403 改为 501 冒充可用。
- 01、02 是之前已实施的通用安全加固与未结缺口，保留证据和代码，不再作为协调聊天上线前置；不宣称这些加固整票已完成，也不借本决定削弱普通账号鉴权/命令签名既有已启用的保护。特殊隔离或限制以后另开 spec，不在此完成。

## 实现计划

1. 先交付 03 的可信 Team Task/Session 创建、首次发送和重开；按用户与资源权限验证真实 Worker 对话，避免只翻门导致 501。
2. 再交付 04 的 Web 选择、发送、恢复与浏览器验收。01/02 安全后续可独立继续，不用旧隔离门串行阻塞真实功能。
3. 记录同候选功能和负例证据；未覆盖能力继续列缺口，不把隔离探针或旧报告改写为功能通过。

## Testing Decisions

- Server API：成员/非成员、撤权、跨 Team、跨 Project Workspace、Worker/Agent 可用性、重复请求、并发首发、原 Task 重开 Session、失联与恢复；真实 Server + 注册 Worker + 非付费 Test Agent 正向创建、发送、结果、重连。
- Web：团队页首屏不创建、选项只含获权资源、首次发送后对话、刷新恢复、重开、出错重试、审批；用真实浏览器验证桌面和手机。普通 Project 对话不受影响。
- 不以 OS 隔离、L1 作用域、全部平台中介写通道拒绝、书面风险接受或付费 Runtime 作为此功能验收条件；现有未经确认的安全保证不得在 UI/文档出现。原始日志不入库，脱敏结果入 `docs/acceptance/`。

## Out of Scope

- 新增操作系统沙箱、宿主文件或网络访问隔离，以及协调身份专属的只读/禁 Shell 策略。安全加固可另行实施，不作为本功能先决。
- 付费真实 Runtime、外部项目管理服务、自动派发与跨 Worker Session 迁移；依各自 spec 验收。
- 历史 Worker 队列/备份清理或重置；需另行确认目标，不因本决定执行删除。

## Tickets

| 票 | 工作 | 依赖 |
| --- | --- | --- |
| [01 会话环境与工具网关历史加固](issues/01-session-scoping-and-gateway-binding.md) | 已有局部成果及剩余风险，作为独立安全后续工作；不阻塞协调功能 | 无 |
| [02 集群命令授权历史加固](issues/02-command-frame-authorization.md) | 保留既有签名和授权成果及未完成项；不阻塞协调功能 | 无 |
| [03 协调 Task/Session 创建与发送](issues/03-gate-standard-reprobe.md) | Server API + Worker 真实对话 + 权限测试，不冒开门 | 无 |
| [04 Web 协调聊天与功能验收](issues/04-coordination-acceptance.md) | Web 发送/恢复/重开 + 浏览器验收 + NEXT-05 逐项签收 | 03 |

票号 01/02 为历史索引，不等于“隔离达标”。旧报告引用的 FAIL 是历史候选事实；当前代码仍禁用且可能尚有 501，变更以新行为测试为准。
