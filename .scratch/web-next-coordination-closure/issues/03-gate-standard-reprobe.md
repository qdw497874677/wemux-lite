# 03: 协调 Task/Session 创建、发送与真实对话

Status: ready-for-human
Blocked by: 无；旧 01/02 的协调专属隔离与全命令安全收口不再是功能前置（ADR 0008）。

**Spec:** [Team 协调聊天贯通](../spec.md)
**合并来源:** `43966aa` 原 04 为隔离资格门重探测；该要求已被用户决定移到未来独立安全工作。本票现在负责真实功能链路，不把历史验收改写为 PASS。
**What to build:** 登录 Team 成员在获权 Worker/Agent/Workspace 上首次发送时自动创建/复用 Team 协调 Task，创建固定 Task/Worker/Workspace/Agent 的 Session 并入队；继续聊天、重开上下文在原 Task 下新建 Session；真实结果可见。原 `POST /api/teams/:teamId/coordination/sessions` 501 与旧静态隔离门须由可用功能替换，不可只翻转常量。

## 实现计划

1. 复用 `teamCoordinationTask` 的确定性 ID，在 Server 事务内用已认证 actor 和 Team 成员身份计算复用键，选择真实就绪的 Workspace Placement，校验 Worker/Agent/模型及 Workspace 的 Project 访问；Session 保持 Team Task 归属而非冒充 Project Task。首次请求的 Session 创建与消息投递保持幂等，不留下孤儿 Task/Session。
2. 使用现有 Worker 命令、Journal 与能力合同，使协调身份能使用与普通对话一致的 Runtime/工具（受已有用户与资源权限、审批约束），不注入新全实例管理权限；服务端协调 grant 不再以只读限制代替真实授权。
3. API 行为测试及真实 Server + 已注册 Worker + 非付费 Test Agent 测创建/消息/结果/重复提交/重开/重连，以及非成员、失权 Workspace、Worker 跨域、他人 Session、伪造身份和未知 Agent 的拒绝。普通 Task 对话不回归。

## 测试与验收

- [x] 仅获权 Team 成员可首次发送自动创建 Team 协调 Task 与 Session；页面打开不创建
- [x] Task 复用键 Team + 用户 + Worker + Agent，Model 不参与；同键重试/并发幂等，不同用户及 Team 互不泄露
- [x] Session 固定 Task/Worker/Workspace/Agent；继续对话可恢复，重开在原 Task 下建新 Session，原历史保留
- [x] 账号、Team、Worker、Workspace/Project、Task/Session 权限逐项通过正反例，不接受客户端自报 owner 或隐式跨 Project 授权
- [x] 普通 Runtime 文件/终端/网络及其既有审批照常可用，不因协调身份静默降为只读，也不隐式取得跨 Project 管理权限
- [x] 已实现的集群命令签名/在线复核不被绕过；不存在 403→501 的假开门路径
- [x] 实际 Server–Worker–Test Agent 对话及负例通过，脱敏证据入库；无付费调用、无数据清理

### 收尾验证记录（2026-10-11，分支 t03-closure，候选 4eb0800）

逐项证据（详细命令与退出码见 `docs/acceptance/web-next-coordination-closure-2026-10-11.md`，历史付费证据见 `docs/acceptance/web-next-team-coordination-browser-partial.md`）：

1. 服务端 `team-coordination-entry` / `team-coordination-functional` / `team-coordination-task`（含“页面打开零新建”、401/403/CSRF/400 无写入、非成员先验成员资格）+ 浏览器 `team-coordination-real-browser.mjs` 桌面/手机真实首发。
2. `teamCoordinationTask` 确定性 ID = Team+用户+Worker+Agent（无 Model，`team-coordination-task.ts`）；本次补写 HTTP 级正例 `reuse key ignores the model`（functional 第 5 测：换模型同 Task 新 Session）；并发幂等收敛（task 测试）；跨 Team/用户隔离（functional ③④ + entry）。
3. 绑定不可变与跨 Run 校验（functional ④、`team-coordination-source-migration`）；浏览器刷新恢复与原 Task 重开保历史两组；Server 重启 replay 保身份。
4. 正反例：viewer/outsider/跨 Team workspace/自报 owner/taskId/移除 grant/移除成员资格（functional）；过期/撤权 token、矛盾协调身份（`capability-task-projection`）；浏览器非成员 HTTP 负例。
5. `capability-service.ts` `prepareTurn` 对协调与普通 Session 同一 ordinary 工具清单（含 `task.create`/`mcp.call`/`http.call`），无协调分支；既有审批在浏览器组照常到达原生 Agent；真实 Pi 文件创建+读回已付费通过（引用既有记录）。边界：终端/网络类等价性由共享能力签发路径结构性支撑，未逐工具实测（见验收文档“已知边界”）。
6. `coordination-command-transport.mjs`（无签名注入 Worker ACK 拒绝、撤权恢复不启动）与 `coordination-approval-transport.mjs`（撤权准入拒、过期/篡改拒）本次重跑通过；gate 为真实投影，源内无协调 501 残留。
7. 本次实际运行（全 Test Agent）：定向 5 测试文件 23/23（exit 0）；全量 Server 串行 952 测试 950 pass，仅 retention-destination 两项因先于 dist 构建运行失败，dist 就位后单跑 2/2；e2e first-send/transport/command-transport/approval-transport/real-browser 全部 exit 0（14 浏览器组）；付费脚本未启用（需显式 `WEMUX_REAL_PAID_PI_E2E=1`），仅使用脚本自建临时目录，未触碰用户数据。

收尾代理未代签人工确认：以上为真实运行与既有证据核对的结果，置 `ready-for-human`，用户复核后可关票。

此票通过后才能进行 [04 Web/功能验收](04-coordination-acceptance.md)；旧安全探针与残余风险接受不再是依赖。
