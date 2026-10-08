# 资源管理与独立 Worker 双宿主（NEXT-11、NEXT-13、NEXT-14）

Status: ready-for-agent

## Problem Statement

资源管理面还不能区分配置、认证、分发与可执行状态，管理员无法确认某个 Agent/Model 究竟"配置了"还是"真能跑"。同时 Worker 必须依赖 Server 才能使用 Web/API：独立安装的 Worker 没有本地鉴权宿主，本地 Task、Session 与结果无法脱离集群使用；入群、重试与退群路径也缺少身份分离保障。

作为用户，我想不用 Server 就能在独立 Worker 上用本地鉴权管理本地 Task、Session 和结果；作为管理员，我想管理 Worker、Agent/Model 能力与 Skill/Preset/Provider 并看到真实可执行状态。

## Solution

1. **资源管理**：Worker、Agent、Model、Skill、Preset、Provider 统一管理面，四态分离（已配置、已认证、已分发、可执行），版本来自运行时真实探测。
2. **独立 Worker 宿主**：本地鉴权 Web/API，本地 Task/Session/结果使用与集群同领域 schema 的独立本地库；不需要 Server 即可完整使用。
3. **身份与入群**：本地身份与 Agent 设置；主动入群、失败可重试、可退出；集群注册身份与本地 Web 用户凭据分离，不自动共享本地会话，入群不自动上传本地记录。
4. **双宿主复用**：运行时与会话界面在两种宿主下复用，差异明示；桌面与移动端验收。

## User Stories

1. 作为管理员，我想管理 Worker 列表与状态。
2. 作为管理员，我想管理 Agent 能力与其可执行状态。
3. 作为管理员，我想管理 Model 与 Provider 配置。
4. 作为管理员，我想管理 Skill 与 Preset。
5. 作为管理员，我想看到"已配置 / 已认证 / 已分发 / 可执行"四态分离，这样不会把配置当成可用。
6. 作为管理员，我想看到来自运行时真实探测的版本与能力。
7. 作为用户，我想在独立 Worker 上用本地鉴权登录 Web。
8. 作为用户，我想在独立 Worker 上创建与管理本地 Task。
9. 作为用户，我想在独立 Worker 上创建 Session 并对话，不需要 Server。
10. 作为用户，我想本地结果可查看与下载。
11. 作为用户，我想本地 Task 与集群 Task 使用同一套领域语义，这样我的心智模型一致。
12. 作为用户，我想本地记录存在独立本地库，不与集群数据混淆。
13. 作为用户，我想配置 Worker 本地身份与 Agent 设置。
14. 作为用户，我想主动把 Worker 加入集群。
15. 作为用户，我想入群失败后能重试。
16. 作为用户，我想能主动退出集群。
17. 作为用户，我想集群注册身份与本地 Web 用户凭据分离。
18. 作为用户，我想入群不自动上传本地记录与会话。
19. 作为用户，我想退出集群后本地能力继续可用。
20. 作为用户，我想双宿主下运行时与会话界面一致，差异被明示。
21. 作为维护者，我想两种宿主复用同一运行时适配与会话 UI，避免两套实现漂移。
22. 作为用户，我想在手机上完成登录、查看 Task 与对话。
23. 作为维护者，我想移动端访问遵守不安全上下文约束（随机 ID 生成、剪贴板降级）。
24. 作为用户，我想在桌面完成管理面与本 spec 覆盖的主要流程。
25. 作为维护者，我想同候选下测试与 e2e 全绿。
26. 作为维护者，我想验收摘要入库、原始证据留 `.scratch/`，并区分已实现、已验证与未完成。
27. 作为管理员，我想远程安装 Agent 时看到明确进度与失败原因（不覆盖全局安装）。
28. 作为维护者，我想本 spec 不改变集群路径的既有安全边界。

## Implementation Decisions

- 四态分离：配置、认证、分发、可执行各自独立状态，界面与接口不合并展示；可执行状态以真实探测为准，失败上报不可用但不阻止 Worker 注册上线。
- 独立 Worker 宿主使用本地鉴权（本地用户凭据），与集群注册身份严格分离；本地库独立，不自动上传、不隐式同步。
- 本地 Task/Session/结果复用同领域 schema 与运行时适配，界面复用同一套会话 UI，宿主差异在界面与文档中明示。
- 入群、重试、退群为显式用户动作；失败可重试，退出后本地能力不受影响。
- 托管 Agent 安装使用固定官方版本、安装到 Worker home 内独立目录，不覆盖全局安装；变更路径后需重启 Worker。
- 双宿主共用同一权限与能力校验路径，不因宿主不同而放宽。
- 移动端遵守不安全上下文约束：随机 ID 统一走 `randomId()`，剪贴板走降级路径。

## Testing Decisions

- 复用现有 seam：Worker CLI 与管理命令、本地宿主 HTTP/API 与鉴权、运行时适配启动路径、web-next 会话界面、现有 e2e 骨架。
- 只测外部行为：四态可区分、真实探测版本、独立宿主无 Server 可用、入群/重试/退群、身份分离、本地记录不上传、双宿主界面一致。
- Prior art：现有 Worker 管理命令测试、本地宿主设计文档、会话界面 e2e、双宿主合同文档。
- 真实浏览器验收覆盖桌面与移动视口。

## Out of Scope

- 新增 Runtime 适配（Codex 属 FUTURE-01）。
- 付费模型签收。
- [迁移收口](../web-next-migration-closure/spec.md)与[切根](../web-next-cutover/spec.md)。

## Tickets

票号仅在本 spec 内有效；跨 spec 引用必须带功能名与文件链接。原票号以提交 `43966aa` 为准，合并只改变跟踪粒度，原验收项全部保留。

| 当前票 | 合并前票号 |
| --- | --- |
| [01 资源管理面](issues/01-resource-management.md) | 01 |
| [02 独立宿主、身份入群与双端验收](issues/02-local-host-enrollment-acceptance.md) | 02、03、04 |

02 内依次推进本地宿主、入群生命周期、桌面手机验收，不另建子票。证据准备完成后转 `ready-for-human`；用户确认前不关闭该 ticket、不认定本 spec 验收通过、不勾选 NEXT-11 / NEXT-13 / NEXT-14。

## Further Notes

- 依据 `docs/design/node-resource-distribution-architecture.md`、`docs/design/m2-dual-host-contract.md`、`docs/design/worker-web-workbench.md`（实现基线）。
- 复用已验证的 Project/Workspace、Task Session、Run/审查及授权基线；资源管理和独立 Worker 不以画布、连接器或协调交接验收作为开工前置。02 的资源与入群依赖见具体 ticket。
- 独立宿主与集群路径的凭据与数据边界必须在验收中显式证明；已交付能力仍需双宿主回归，不因解除无关串行依赖而放宽安全或验收范围。
