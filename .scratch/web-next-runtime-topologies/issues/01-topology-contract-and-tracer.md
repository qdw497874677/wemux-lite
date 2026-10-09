# 01: 运行形态合同与真实纵向验证

Status: needs-info
Blocked by: [需求基线](../../../docs/specs/ai-workbench-requirements-alignment.md) D4 的平台 Runtime 技术选型与部署合同仍待设计；单 Worker 完整任务执行场景已确认，可先盘点 Adapter 和比较复用方案，不预选部署架构。使用远程执行时需[命令授权](../../web-next-coordination-closure/issues/02-command-frame-authorization.md)，新增自动候选派发需[派发 01](../../web-next-task-dispatch/issues/01-placement-claim-dispatch.md)；指定 Worker 的合同验证可独立准备。

**Spec:** [运行形态](../spec.md)
**What to build:** 从明确真实场景出发验证 loop-in（Worker 本机 Runtime）与 loop-out（平台 Runtime 驱动、Worker 执行工具）的合同差异，先交付用户选定的首条链路；其他已确认目标保留显式缺口，不以设计文档冒充实现。

## 实现计划

1. 盘点 `apps/worker/src/agents`、RuntimeSessionAdapter、Worker 工具入口与 Server Session 服务，绘制身份/数据/工具流，列现有支持和缺口。
2. 按已确认 D4 场景比较平台 Runtime 复用方案，不默认从零自研；形成选型并冻结部署位置、工具集合、凭据来源、事件序列、取消/恢复语义与资源计量。必要时记录 ADR，不硬编码特定 SDK 为平台合同。
3. 复用共同授权服务和 Task/Run 身份实现首条链路，限制工具到具体 Worker/Workspace/操作；重试保留领域身份，未知外部副作用不盲重放。
4. 用真实免费/本地 Runtime 跑浏览器创建、执行、停止、结果与断线恢复，记录剩余形态责任及后续计划；未全部覆盖时 spec 不完成。

## 验收

- [ ] 按已确认术语验证 loop-in 使用 Worker 本机 Runtime、loop-out 使用平台 Runtime；后者不能以任意外部 Agent 远程调用或单个模型请求冒充
- [ ] 平台 Runtime 实现与部署位置完成设计比较；遵循 D4 已确认场景，项目管理角色不与 Runtime 形态混同
- [ ] 用户选择平台 Runtime、推进 todo 后，按获权范围和容量分配单 Worker，完整经历读文件、改代码、运行测试及任务会话中的过程/成果呈现，不以一次远程工具调用代替
- [ ] 两种形态共用看板、分配、授权、容量与会话/成果视图；首条链路不跨多 Worker、不透明迁移或自动同步文件/凭据
- [ ] 运行形态能力表标明已有实现、真实验证、未实现及后续工作
- [ ] 首条链路固定 Task/Worker/Agent 归属，流式结果与工具副作用可审计
- [ ] 错误身份、撤权、重复消息、失联与取消均有行为证据，权限不因 loop 外置而扩大
- [ ] 真实 Runtime 与桌面/手机入口验证，成本或凭据缺失如实阻塞
- [ ] 每个剩余形态目标已有链接到的开放后续 ticket，含责任、待决选择、验收目标及状态（未决用 needs-info），并更新 spec/索引；D5 切换范围与文档一致

首条链路及证据完成后转 `ready-for-human`；用户确认该切片且上述后续开放票已建好后才可关闭，不以本票关闭自动宣告所有运行形态支持完成。
