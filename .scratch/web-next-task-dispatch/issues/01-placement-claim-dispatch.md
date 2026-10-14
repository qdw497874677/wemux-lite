# 01: 机器范围、申领与持久派发

Status: ready-for-agent（部分完成：合同、持久承接、应用服务、任务侧与 Worker 侧接口、任务详情界面与真实链路验证已实装；8 条验收项部分完成或未开始，见「验收记录」）
Blocked by: [需求基线](../../../docs/specs/ai-workbench-requirements-alignment.md) D1–D3 及未配置默认 1、支持配置上限均已确认，无待决容量默认阻塞；合同与测试准备可先行。真实执行需[命令授权](../../web-next-coordination-closure/issues/02-command-frame-authorization.md)，不依赖协调聊天开门，也不等待派发 02 整票完成。

**共同合同（非整票阻塞）:** 与 [02](02-capacity-team-board-acceptance.md) 共用容量合同：本票实现显式容量下的原子预约与启动准入，02 扩展共享策略、遥测和端到端验收。无有效容量准入证明不启动；未配置上限时采用默认 1，机器管理者可配置，首次接入不要求先手工配置；默认值不替代当前占用和授权的准入校验。实际 Runtime/Git 凭据的使用主体与范围由本票冻结；排队期间机器范围修改须在启动前重新核验，已绑定会话不隐式迁移，取消/重新排队策略归 D3。

**Spec:** [项目看板与团队远程任务派发](../spec.md)
**What to build:** 从 Task 的机器范围与一次执行意图，经指定派发/候选申领，到获权 Worker 上 Task Session 的完整链路。复用已有指定 Worker 路径，不将 Task 永久锁为单会话。

## 实现计划

1. 先冻结任务管理 Module 的可替换 Interface：任务身份/版本、状态语义、授权上下文和执行事实回写，内置 Kanban 使用内置 Adapter；执行 Module 不直读看板字段或假定跨系统事务。从 `apps/server/src/application/task-service.ts`、`packages/domain` 与 `packages/wire-protocol` 盘点 Assignment/Run 快照，补候选范围、执行意图与持久承接记录；先建包再检查下游。
2. 把请求执行、申领、撤销和等待原因封装为同一应用服务；SQLite 事务原子检查请求幂等、最新权限、执行权与容量预约。Worker 仅能以自身身份申领。
3. 接入可靠投递及 Worker 启动前准入，保留领域身份；未确认承接与已承接结果未知分开恢复，不只凭超时换机器启动。
4. 在看板/任务详情提供机器范围和状态操作，按 D1 将 todo 迁移可靠关联执行意图，不增加入队开关；实际启动后进入 in_progress。用户与项目管理工具走同一授权服务，重复事件和重入 todo 先核对在途执行。按 D3 支持未派发 Task 重新选机，可能已执行的先对账；同目标可由获权主体安排原 Task 新 Session 接手（可保持 in_progress，无需退回 todo），接手意图检查权限/依赖/容量及旧执行事实；额外独立工作另建 Task。派发器不自动重试任务，不迁移原会话。
5. 用并发持久存储测试和两 Worker WebSocket 链路验证唯一承接、重放与故障，再做真实浏览器验收。

## 验收

- [ ] 内置任务管理 Adapter 与异构状态/标识测试 Adapter 通过同一 Interface 合同；替换映射不改 Worker/Runtime，测试替身不冒充外部集成
- [ ] 单一任务状态权威、稳定来源绑定、版本冲突及回写失败可恢复；外部事件仍校验权限，重复/乱序不导致重复执行或历史 Session 换绑

- [x] 任意获权候选、候选集合、固定 Worker 三种范围真实生效，越权直接 API 被拒
- [x] 创建 backlog 不派发；创建或迁移到 todo 自动参与申领/派发，无额外入队操作；无可用机器/容量时保持 todo 并显示原因
- [ ] 消费任务管理的版本化依赖资格，承接/启动前重新核验；前置待审查不启动下游，依赖解除重新匹配已有 todo 执行意图及已明确安排的 in_progress 接手意图，不启动 backlog、不新建或重复执行。依赖编辑/审查真实联动与项目管理 01 联合验收，双方合同可先行，不设整票循环依赖
- [ ] 实际启动后进入 in_progress；blocked/done/cancelled 阻断后续派发，提交成果按审查策略处理而非 Run 成功即完成
- [x] 重复状态更新、事件重放、重入 todo 不复制在途或结果未知的执行；同一执行意图并发申领、指定派发竞争仅产生一个有效承接
- [ ] 幂等重试/重启不重复建立 Run/Session 或启动进程
- [ ] 一个 Task 可有多个明确安排的 Session；修改范围不换绑已建 Session
- [ ] Worker 检查 Runtime、模型、Placement、权限与容量；陈旧资格不能绕过启动检查
- [x] 按 D3 展示等待/不可用/结果未知，撤销与启动竞态、旧执行权重放有负例
- [x] 未派发时可在合格候选中重新选机；固定机器离线等待，范围修改需授权；已派发启动未知或执行中失联先核对进程、记录与结果
- [ ] 共同 Interface 由本票负责冻结，项目管理 01 提供进度记录/冻结审查领域定义；支持获权追加/查询、稳定来源和有效审查策略读取，接手不重新解析项目默认，异构 Adapter 不丢已有记录/策略
- [x] 接手绑定旧执行身份与代次，不同 requestId 同时接替只能一个成功；禁止旧执行权、排队 Turn 和迟到消息越过交接边界重新启动，无权控制或事实未知则等待，不永久锁住整个 Task
- [x] 普通派发消费 todo，显式接手消费 in_progress 及独立资格；blocked/in_review/终态接手被拒。接手等待容量后按持久意图重新匹配，与普通任务按本次执行安排入队时间排序，无特殊优先级、不沿用原 Task 的旧 todo 时间；重复请求与重启不重排，不迫使 Task 退回 todo
- [x] 原 Task 可在 in_progress 下明确安排新 Session 接手，旧会话保留，审查要求不变；接手前确认旧执行停止或完成安全对账，任务进度记录不替代 Workspace 准备
- [ ] 后续 Task 新建自己的执行及 Session，并检查授权、代码/Placement；修改范围、重入 todo、重复改派或换 Task 标识不绕过相关未知执行的安全核验，不提供任务自动重试
- [x] 指定机器手工执行无需协调入口开放；多人 API 保留真实操作者与委托主体
- [x] 桌面/手机浏览器及真实两 Worker 证据入脱敏摘要；本机进程不冒充异构宿主

## 验收记录（2026-10-14，分支 `dispatch-01-placement`，基点 `8cf9bff`）

已实现并验证：派发领域判定合同（`packages/domain/src/dispatch.ts`）、派发线协议（`packages/web-contract/src/task-dispatch.ts`）、SQLite 持久承接（`apps/server/src/storage/sqlite/dispatch-claims.ts`，并发唯一性由部分唯一索引裁决）、`TaskService` 的机器范围/显式安排/申领/释放/接手服务、任务侧与 Worker 侧 HTTP 接口、`apps/web-next` 任务详情派发界面与 `packages/web-client` 客户端操作。容量合同与票据 02 共用：未配置上限默认 1，机器管理者可配置；**没有承接就没有启动**，容量准入证明即持久承接记录。

逐条验证：18 条验收项中 **10 条通过**（三种机器范围与越权拒绝、状态驱动派发与等待原因、重复/重放不复制与并发唯一承接、D3 等待与结果未知展示与负例、未派发重新选机与固定机器等待、接手绑定旧执行身份与代次、普通派发与接手各自消费的状态与排队顺序、in_progress 接手与旧会话保留、无需协调入口的手工指定机器执行、桌面手机与两 Worker 证据），**8 条部分完成或未开始**：①⑬ 任务管理 Module 可替换 Interface 与异构 Adapter 替身未开始（冻结工作与计划交接 01 共用）；⑤ 版本化依赖资格未开始（需与计划交接 01 联合验收）；⑥ 实际启动后进入 in_progress 未实装（需改共享 Run 投影，机器侧启动接线归票据 02/计划交接 01）；⑧⑩ 意图/承接层面的幂等与承接准入已实现并验证，但 Run/Session 建立与进程启动前的准入门未接线；⑨「不换绑已建 Session」已验证，多 Session 的实际建立归执行侧；⑰ 安全核验与不自动重试已验证，后续 Task 的执行/Session 建立路径未实装。

证据：`npm run build:packages`、`npm run typecheck`、`node --import tsx --test apps/server/src/test/*.test.ts`（988/988）、`npm test --workspace @wemux/worker`（532，0 fail）、`node --import tsx apps/e2e/dispatch-claim-transport.mjs`（13 项真实链路断言）、`node --import tsx apps/web-next/tests/task-dispatch.browser.mts`（桌面 1440×900 与手机 390×844，7 项检查，稳定复跑 2 次）退出码全 0，日志在 `/var/tmp/wemux-p01-logs/`（不入库）。脱敏验收摘要见 [`docs/acceptance/placement-claim-dispatch.md`](../../../docs/acceptance/placement-claim-dispatch.md)；截图与原始日志不入库。两 Worker 为同机独立进程，只证明协议链路与并发唯一性，不作为异构宿主证据。
