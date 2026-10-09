# loop-in、loop-out 与可选平台 Runtime

Status: needs-info

## Problem Statement

已确认支持外部 Agent Runtime 与可选平台 Runtime，并覆盖 loop-in/loop-out；既有 pi/claude/opencode Adapter 不能证明全部运行形态已经实现。若仅在 README 声明而没有设计与验证责任票，目标会遗漏。

## 需求与边界

来源为[需求基线](../../docs/specs/ai-workbench-requirements-alignment.md)第 8 项。术语已确认：loop-in 使用 Worker 本机 Agent Runtime 运行完整 loop；loop-out 使用平台 Runtime 驱动 loop，通过受控接口调用 Worker 工具。不得以任意外部 Agent 调用远程工具替代 loop-out 验收，也不把模型 HTTP 请求本身当作完整 Runtime。平台 Runtime 是 loop-out 的组成部分；D4 首个场景已确认如下，部署位置及实现选型仍待设计，不预设必须位于 Server 进程，也不等同于项目管理角色。

用户希望不同形态均能在 Task 下开展可停止、可审计、可恢复的 Session，共用项目管理工具和 Worker 权限；凭据、工具副作用和资源占用边界清楚。不引入默认 Kubernetes、模型推理集群或内核隔离要求。

## 已确认的首条 loop-out 链路

用户选择平台 Runtime，将任务推进到 todo。平台按任务获权机器范围和容量分配一台 Worker；平台 Runtime 驱动完整 Agent loop，在该 Worker 的获权 Workspace 中读取文件、修改代码、运行测试，过程与成果呈现在原 Task 的 Session 中。

两种形态共用看板、任务分配、权限、容量、会话和成果视图，不另设 loop-out 任务流程。首条链路固定一台 Worker，不做同 Session 跨多机执行，不承诺透明迁移或文件/凭据自动同步。一次远程构建测试不算完整链路验收。技术选型单独比较复用方案，不默认从零自研 Runtime。

## 实现计划

1. [01](issues/01-topology-contract-and-tracer.md) 按已确认术语，以具体场景明确平台 Runtime 部署位置、工具执行路径、身份/凭据、Task/Run/Session 归属和断线取消合同，记录 D4。
2. 对照现有 RuntimeSessionAdapter 比较平台 Runtime 的复用方案、工具执行路径、持久恢复和部署成本，形成技术选型，再实现已确认的单 Worker 完整任务链路；不重新选择用户场景，不先造所有形态的统一框架。
3. 同一项目任务从授权到工具执行、流式结果、停止、恢复贯通；平台 Runtime 不得到无限 Worker 操作令牌。
4. 真实本地/免费运行环境验证后回写能力表，其余形态如实未完成。D5 已确认 loop-in 与上述单 Worker loop-out 完整链路纳入本次切换验收，不将一个原型当完整链路或全形态完成。

## Testing Decisions

协议测试覆盖错身份、过期/撤权、重复工具执行、断线未知副作用和取消；真实进程与浏览器链路证明 Task 归属及结果可追溯。test-agent 只证明适配合同，不替代真实 Runtime。无付费调用或安装授权。

## Tickets

| Ticket | 交付 |
| --- | --- |
| [01 运行形态合同与真实纵向验证](issues/01-topology-contract-and-tracer.md) | 完成技术选型并验证单 Worker 平台 Runtime 完整任务链路，登记其他目标缺口 |
