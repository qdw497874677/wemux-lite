# 03: 协调 Task/Session 创建、发送与真实对话

Status: ready-for-agent
Blocked by: 无；旧 01/02 的协调专属隔离与全命令安全收口不再是功能前置（ADR 0008）。

**Spec:** [Team 协调聊天贯通](../spec.md)
**合并来源:** `43966aa` 原 04 为隔离资格门重探测；该要求已被用户决定移到未来独立安全工作。本票现在负责真实功能链路，不把历史验收改写为 PASS。
**What to build:** 登录 Team 成员在获权 Worker/Agent/Workspace 上首次发送时自动创建/复用 Team 协调 Task，创建固定 Task/Worker/Workspace/Agent 的 Session 并入队；继续聊天、重开上下文在原 Task 下新建 Session；真实结果可见。原 `POST /api/teams/:teamId/coordination/sessions` 501 与旧静态隔离门须由可用功能替换，不可只翻转常量。

## 实现计划

1. 复用 `teamCoordinationTask` 的确定性 ID，在 Server 事务内用已认证 actor 和 Team 成员身份计算复用键，选择真实就绪的 Workspace Placement，校验 Worker/Agent/模型及 Workspace 的 Project 访问；Session 保持 Team Task 归属而非冒充 Project Task。首次请求的 Session 创建与消息投递保持幂等，不留下孤儿 Task/Session。
2. 使用现有 Worker 命令、Journal 与能力合同，使协调身份能使用与普通对话一致的 Runtime/工具（受已有用户与资源权限、审批约束），不注入新全实例管理权限；服务端协调 grant 不再以只读限制代替真实授权。
3. API 行为测试及真实 Server + 已注册 Worker + 非付费 Test Agent 测创建/消息/结果/重复提交/重开/重连，以及非成员、失权 Workspace、Worker 跨域、他人 Session、伪造身份和未知 Agent 的拒绝。普通 Task 对话不回归。

## 测试与验收

- [ ] 仅获权 Team 成员可首次发送自动创建 Team 协调 Task 与 Session；页面打开不创建
- [ ] Task 复用键 Team + 用户 + Worker + Agent，Model 不参与；同键重试/并发幂等，不同用户及 Team 互不泄露
- [ ] Session 固定 Task/Worker/Workspace/Agent；继续对话可恢复，重开在原 Task 下建新 Session，原历史保留
- [ ] 账号、Team、Worker、Workspace/Project、Task/Session 权限逐项通过正反例，不接受客户端自报 owner 或隐式跨 Project 授权
- [ ] 普通 Runtime 文件/终端/网络及其既有审批照常可用，不因协调身份静默降为只读，也不隐式取得跨 Project 管理权限
- [ ] 已实现的集群命令签名/在线复核不被绕过；不存在 403→501 的假开门路径
- [ ] 实际 Server–Worker–Test Agent 对话及负例通过，脱敏证据入库；无付费调用、无数据清理

此票通过后才能进行 [04 Web/功能验收](04-coordination-acceptance.md)；旧安全探针与残余风险接受不再是依赖。
