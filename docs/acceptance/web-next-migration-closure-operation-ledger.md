# 迁移收口 01：操作级迁移登记表（NEXT-15）

本表是[迁移收口与旧版移除条件](../../.scratch/web-next-migration-closure/spec.md)票据 01 的登记交付，源为[平台规格 §4 迁移登记表](../../docs/specs/web-next-project-agent-platform.md)逐行细化；旁路勘察与调用方转换清单见[无 Task 旁路勘察报告](web-next-migration-closure-bypass-survey.md)。历史基线（旧版逐行内容与早期证据）见[新版操作级迁移登记（Ticket01基线）](web-next-operation-migration.md)，本表不删除该基线，只按本 spec 的状态词重新登记并补证据指针。

## 定位与范围

- 范围＝旧 Web 公开操作 + 独立 Worker 工作台 + 新版 `/next/*` 现有操作 + 已确认 D5 新增目标。
- 本表**不是**"目录存在即有效"的功能列表。每行必须落到操作级（入口、角色、权限、状态、证据、责任票）。
- 旧版删除不在本 spec 内执行；本表结论不构成删除授权（切根见[切根 go/no-go](../../.scratch/web-next-cutover/issues/02-go-no-go-cutover.md)）。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| 已验证（本票） | 本票运行了断言/测试，证据在本票证据根可复查 |
| 已验证（既有） | 仓库既有验收文档记录成功，本票未重跑（02/03 需复跑或明确豁免） |
| 已实现未验证 | 新版入口/合同存在，无本轮真实证据（多为缺浏览器或真实外部服务） |
| 未实现 | 新版无该能力 |
| 被替代 | 旧行为被新规则替代（无 Task 会话创建） |
| 未实施 | 运维/切根动作，未执行 |

权限代号（最终以服务端判定，UI 判断不替代）：A 本人账号；TA 团队 owner/admin；PV 项目可见成员；PM 项目管理者；SW 会话获权写；SC 会话获权控制；WV 节点 use；WM 节点 manage/实例管理员；L 本机 Web 身份；C 外部连接器/Channel 受限能力。PM 不自动取得私有 Session 内容。

## 本票证据根与边界

- 本票证据根：`/var/tmp/wemux-m01-verify/`（原始，不入库）。工作树 `/tmp/wemux-m01`，基点 `8cf9bff`。
- 断言/测试证据：
  - `scripts/migration-bypass-survey.mjs` → `bypass-survey.log`（29/29，EXIT=0）、`bypass-inventory.json`
  - `apps/server/src/test/task-session-contract.test.ts` → 19/19，EXIT=0（`task-session-contract.log`）
  - `apps/server/src/test/task-delete.test.ts` + `task-delete-artifacts.test.ts` → 5/5，EXIT=0（`task-delete.log`）
  - Server 定向批（`task-runs` 126、`task-workspaces` 18、`session-workbench` 16、`tasks` 7、`team-coordination-task` 7、`capability-task-projection` 8、`session-effect-authorization` 3、`task-assignment-http` 2、`task-completion-http` 1、`task-metadata-contract` 1、`task-workspace-create-idempotency` 1、`session-authorization-http` 1）→ 合计 191/191，全部 EXIT=0（`server/*.log`）
  - `apps/worker/test/local-workbench.test.ts` → 3/3，EXIT=0（`local-workbench.log`）
- **边界**：本机无 playwright-core 与 chromium 缓存，本票未执行浏览器验收。凡标注"已验证（本票）"只到断言/测试级；浏览器级迁移证据仍缺，见缺口 G-04。
- 证据文档简写（均相对 `docs/acceptance/`）：E-cand=web-next-phase1-candidate.md；E-t01=web-next-operation-migration.md（Ticket01 integration + 独立审查补验）；E-t02=web-next-account-team-membership.md；E-t03=web-next-project-workspace-task-management.md；E-t04=web-next-dedicated-conversation-task.md；E-t05=web-next-coordination-04-acceptance.md；E-authz=web-next-session-effect-authorization.md；E-m2w=m2-worker-local-workbench.md；E-rw1=r-web-session-slice.md；E-rw2=r-web-queue-approvals.md；E-rw3=r-web-local-settings-cluster.md；E-entry=web-next-entry-login-projects.md。

## §4-1 启动、路由、账号

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| 登录、Cookie 恢复、退出 | `/next/` 内联表单 + 壳退出 | A | 已验证（既有） | E-t01（real-instance 桌面/手机）、E-cand | 01 |
| 注册、重发验证、验证邮箱 | `/next/login`、`/next/auth/verify-email` | 匿名 | 已验证（既有） | E-t02（67 项浏览器含双端） | 02 |
| 找回密码、重置 | `/next/auth/password/reset` | 匿名 | 已实现未验证 | E-t02 残余（真实 SMTP 未签收） | 02 |
| Google 登录、绑定、解绑 | `/next/login`、`/next/settings` | A | 已实现未验证 | 真实 OAuth 为外部门（[外部门 01](../../.scratch/web-next-external-gates/issues/01-real-external-services.md)） | 02 |
| 修改密码、邮箱变更确认 | `/next/settings`、`/next/auth/confirm-email-change` | A | 已实现未验证 | E-t02 残余 | 02 |
| 登录会话列表、撤销单会话、退出其他设备 | `/next/settings` | A | 已验证（既有） | E-t01 独立审查补验（公开 DELETE 撤销、桌面/手机断言） | 02 |
| PAT 创建、轮换、撤销 | `/next/settings` | A | 已实现未验证 | 无本轮断言 | 02 |
| 账号注销、禁用、恢复、管理员删除 | `/next/settings` | A / 实例管理员 | 已实现未验证 | 无本轮断言 | 02 |
| 注册策略、审计查询/导出 | `/next/settings` | 实例管理员 | 已实现未验证 | 无本轮断言 | 02 |
| 旧版入口切换与删除 | 壳"旧版控制台"链接（`Shell.tsx`） | - | 未实施 | 切根 spec | 切根 01/02 |

## §4-2 Team 与资源权限

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| 团队创建、切换、成员查看 | `/next/teams` | A / 团队成员 | 已验证（既有） | E-t02 | 02 |
| 邀请、重发/撤销、查看/接受邀请 | `/next/teams`、`/next/join` | TA / 受邀本人 | 已验证（既有） | E-t02 | 02 |
| 成员改角色、移除、转让所有权 | `/next/teams` | TA | 已验证（既有） | E-t02 | 02 |
| 项目可见范围、成员角色授予/撤销 | `/next/projects/:id` 管理 | PM | 已验证（既有） | E-t03（42 项浏览器 + 双端 115 项） | 03 |
| Worker 共享范围、使用/管理授权 | 新版无集群页 | WM | 未实现 | 旧版保留 | 11 |
| 会话访问授权、共享范围、撤销 | 新版无会话授权 UI | SC | 未实现 | 旧版保留 | 09 |
| 撤权/删除在跨页、跨宿主、跨 Runtime 全出口即时生效 | - | 按各出口 | 未验证 | 需 03 矩阵 | 03 |

## §4-3 项目与工作区

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| 项目列表、搜索、打开、深链接、刷新/后退 | `/next/projects`、`/next/projects/:id` | PV | 已验证（既有） | E-t01、E-cand、E-entry | 01 |
| 创建项目、配置 Repository | `/next/projects` 创建表单 | 项目创建授权 | 已验证（既有） | E-t03 | 03 |
| 项目改名、删除 | `/next/projects/:id` 管理 | PM / 实例管理员 | 已验证（既有） | E-t03 | 03 |
| Workspace 列表、创建、选取 | `/next/projects/:id` | PV + WV | 已验证（既有） | E-t03 | 03 |
| Placement 新增、重建、重试 | `/workspaces/:id/reprovision` 合同 | PM / WV | 已验证（既有） | E-t03（旧 client 方法≠endpoint，经 reprovision 新增落点） | 03 |
| Workspace 删除 | - | PM | 未实现 | 固定 501（E-t03 边界） | 03 |
| 实际 Worker 文件准备（clone/落盘） | - | WV | 未验证 | ready 报告≠真实准备（E-t03） | 03 |

## §4-4 Task、Run、审查

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| Task 创建、编辑标题/描述/状态/优先级 | `/next/projects/:id` 任务面板 | 项目写 | 已验证（本票，断言级） | `tasks` 7/7、`task-metadata-contract` 1/1；E-t03 | 03 |
| Task 添加/移除 Link、查看活动 | 任务详情 | 项目写 / PV | 已验证（本票，断言级） | `tasks` 7/7；E-t03 | 03 |
| 指派/清除 Agent、绑定/解绑 Workspace | 任务详情 | 项目写 + WV | 已验证（本票，断言级） | `task-assignment-http` 2/2、`task-workspaces` 18/18；E-t03 | 03/07 |
| Task 内创建 Workspace、失败重试 | 任务详情 | 项目写 + WV | 已验证（本票，断言级） | `task-workspace-create-idempotency` 1/1、`task-workspaces` 18/18；E-t03 标未验，本票补齐断言级 | 03 |
| Task 删除（CAS tombstone） | 任务详情删除 | PM / owner | 已验证（本票，断言级） | `task-delete` 5/5；**基线"Task DELETE 无合同"已过时（D-06）** | 03 |
| 启动 Run、复用 Session、取消 Run | 任务详情 | 项目执行权 | 已验证（本票，断言级） | `task-runs` 126/126 | 07 |
| 成果登记、Run 关联、成果审查 | - | 项目写 / 审查者 | 已实现未验证 | 无本轮断言 | 10/07 |
| 提交完成、审查批准/要求修改 | - | 配置管理 / 审查者 | 未实现 | 多阶段/Agent 审查未实现（E-t03、基线） | 07 |
| 成功停止已提交准备 | - | - | 未实现 | 基线登记缺口，未找到有效协议 | 03/07 |

## §4-5 Session

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| 会话列表、打开历史、深链接补选 | 任务详情会话列表 | 会话 read | 已验证（本票，断言级） | `session-workbench` 16/16 | 04 |
| 创建会话（显式 Task 合同） | 任务详情创建 / `createTaskSession` | SW + WV | 已验证（本票，断言级） | `task-session-contract` 19/19（L1–L2 断言）；E-t04 | 04 |
| 创建会话（旧无 Task 入口 → 自动专用 Task） | `POST /api/sessions`（`createDedicatedSession`） | SW + WV | 已验证（本票，断言级） | `task-session-contract` 19/19（S1–S4）；E-t04（Server 662/662） | 04/02 |
| 发送文本、图片/附件、消息排队 | `ConversationComposer` | SW | 已验证（既有） | E-t04（真实 Worker+Test Agent 浏览器 12 组）、E-cand | 04 |
| 停止 Turn、取消排队消息 | `ConversationControls` | SC / SW | 已实现未验证 | 基线局部测试，真实 Runtime 待复验 | 04 |
| 运行时命令、compact、计划/todo、建议输入 | - | SW + Runtime 能力 | 已实现未验证 | 基线待核验 | 04/08 |
| 同一 Session 切换 Model | `ConversationModelSelection` | SW | 已验证（本票，断言级） | `task-session-contract` 19/19（模型变更复用同 Task）；快照规则仍待浏览器验收 | 04 |
| 审批工具操作、拒绝、查看状态 | - | 审批授权 | 已实现未验证 | 基线局部（E-rw2） | 04/07 |
| 工具流、用量、Markdown、历史/断线恢复 | `SessionConversation` | 会话 read | 已实现未验证 | 多 Runtime 未知 | 04/08 |
| 会话改名、归档/恢复、删除 | - | SC | 已实现未验证 | 无本轮断言 | 04 |
| 私有会话授权、共享范围、撤销 | - | SC | 未实现 | 新版无该 UI | 09 |
| Fork 会话（同 Task） | - | 源/目标授权 | 未实现 | 跨 Task 复制被禁止，同 Task Fork 未迁移 | 09 |

## §4-6 画布与血缘

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| 查看画布/血缘、切换单会话、拖动保存布局 | - | PV + 每 Session read | 未实现 | 新版无画布 | 09 |
| 画布协作 presence、焦点/typing | - | 会话 read | 未实现 | 新版无画布 | 09 |

## §4-7 文件、终端、成果

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| 浏览/读取/写入文件、Diff 预览 | - | 会话 read/write | 未实现 | 新版无文件面板 | 10 |
| 创建终端、写入、调整尺寸、关闭 | - | 执行授权 | 未实现 | 新版无终端面板 | 10 |
| 成果登记与审查（同 §4-4） | - | 项目写 / 审查者 | 已实现未验证 | 见上 | 10/07 |

## §4-8 待办、审批、活动

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| 待办聚合、跳转审批/任务 | `/next/attention` | 可见资源 | 已验证（既有） | E-cand（next-attention-review/sources e2e EXIT=0） | 07 |
| 项目/任务活动、全局时间线 | - | PV | 未实现 | 新版无时间线 | 07/15 |

## §4-9 集群与 Runtime

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| Worker 注册令牌、安装命令、tailnet 诊断 | - | WM | 未实现 | 新版无集群页，旧版保留 | 11 |
| Worker 健康/版本/撤销、能力查看 | - | WV / WM | 未实现 | 同上 | 11 |
| Agent/Model 选择、不可用原因 | 任务/试聊选项 | WV | 已实现未验证 | 无本轮断言；逐 Runtime 见 08 | 11/08 |

## §4-10 Skill、Preset、Provider

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| Skill 编辑、版本发布、绑定、启停、分发 | - | 管理授权 | 未实现 | 新版无资源面板 | 11 |
| Preset 编辑、显式应用、部署差异/重试 | - | WM | 未实现 | 同上 | 11 |
| Provider 版本发布、绑定、候选 Model | - | 管理授权 | 未实现 | 同上 | 11 |

## §4-11 连接器与 Channel

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| Connector 列表、创建/编辑、启停、连接测试 | - | PM + C | 未实现 | 新版无连接器页 | 12 |
| Connector 能力调用、审批、结果查看 | - | C + SW | 未实现 | 同上 | 05/12 |
| Channel 创建、测试、启停、令牌轮换/删除 | - | PM + C | 未实现 | 同上 | 12 |
| Channel 绑定创建/启停、失败投递重放 | - | PM + C | 未实现 | 同上 | 12 |

## §4-12 本地 Worker（独立宿主）

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| 本地登录/退出、目录授权 | 旧 `/local`；新版 `App.tsx` 明示未迁移 | L | 未实现 | E-m2w（旧版局部）、E-rw1 | 13 |
| 本地建会话、发送/停止/队列/审批/历史 | 旧 `/local/sessions`；创建链无 Task | L | 被替代 + 未实现 | 本票 W1–W3（本地 `taskId` 零命中）；E-rw1/E-rw2 为旧 fixture | 13/02 |
| 本地 Agent 路径选择/重置、托管安装 | 旧 `/local/settings` | L | 未实现 | E-rw3、基线 | 14 |
| 本地 Provider 凭据新增/更新/删除 | 旧 `/local/settings` | L | 未实现 | E-rw3 局部 | 14 |
| 本地 Connector 保存/删除 | 旧 `/local/settings` | L + C | 未实现 | 基线待核验 | 14 |
| 发现 Server、加入/暂停/恢复/退出集群 | 旧 `/local/cluster` | L + 注册令牌 | 未实现 | E-rw3 局部 | 14 |

## §4-13 交互公共能力

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| 全局命令/搜索、快捷导航、未保存提醒 | `/next/` 壳（⌘K） | 当前可见对象 | 已验证（既有） | E-t01 子集（项目搜索/命令/离开提醒） | 01/15 |

## 新增目标（已确认 D5，本次切换范围，单列不并入旧验收）

| 操作 | 新版入口 | 角色 / 权限 | 状态 | 证据 | 责任票 |
| --- | --- | --- | --- | --- | --- |
| 派发：候选范围（全部/候选集/固定机）、指定派发、开放申领 | - | 项目管理 / 获授权 Agent | 未实现 | [派发 01](../../.scratch/web-next-task-dispatch/issues/01-placement-claim-dispatch.md) | 派发 01 |
| 容量预约与多用户公平使用（默认 1 执行槽位，可配置） | - | 机器管理者 | 未实现 | [派发 02](../../.scratch/web-next-task-dispatch/issues/02-capacity-team-board-acceptance.md) | 派发 02 |
| 重新分配、可能已执行时先对账 | - | 项目管理 | 未实现 | 派发 01/02 | 派发 01/02 |
| 可替换任务管理 Interface | - | - | 未实现 | 合同归派发 01 | 派发 01 |
| 持续推进（项目管理分项 B） | - | 项目职责授权 | 未实现 | [计划交接 02](../../.scratch/web-next-plan-handoff/issues/02-cross-runtime-loop-acceptance.md) | 计划交接 02 |
| loop-in 及单 Worker loop-out 运行形态 | - | - | 未实现 | [运行形态 01](../../.scratch/web-next-runtime-topologies/issues/01-topology-contract-and-tracer.md) | 运行形态 01 |
| 项目级 Agent API（发现、建 Task、读关联 Session） | - | 可信身份交集 | 未实现 | `capability-task-projection` 8/8 只覆盖既有投影，不等于新能力 | 协调 05/08 |
| Team 协调聊天（懒创建/复用/重开上下文） | - | 受限执行 | 未实现 | E-t05 为历史阶段证据，非本次 | 协调 05 |
| 版本计划批准、固定版本交接 | - | 协调/任务计划 | 未实现 | [计划交接 01](../../.scratch/web-next-plan-handoff/issues/01-plan-approval-and-handoff.md) | 计划交接 01 |
| 数据重置、正式入口切换、旧版移除 | - | 运维 | 未实施 | [切根 01](../../.scratch/web-next-cutover/issues/01-backup-reset-clean-instance.md) | 切根 01/02 |

## 缺口汇总

| 缺口 | 内容 | 责任票 |
| --- | --- | --- |
| G-01 | 本地（独立 Worker）Task Session 能力未实现；无 Task 本地创建链不能移除 | 双宿主 13、迁移收口 02 |
| G-02 | 旧调用方未显式走 Task 合同；root 创建仍接受省略 taskId | 迁移收口 02 |
| G-03 | legacy 无 Task 会话清理与切根未实施 | 切根 02 |
| G-04 | 浏览器级迁移证据本票不可得（无 playwright/chromium） | 迁移收口 03 |
| G-05 | 画布/血缘、文件、终端、成果、集群/Runtime、资源（Skill/Preset/Provider）、连接器/Channel、本地宿主新版入口整体缺失 | 协作界面 01/02/03、双宿主 01/02 |
| G-06 | 多阶段/Agent 审查、成功停止已提交准备、私有会话授权、活动/时间线未实现 | 07/09/03/15 |
| G-07 | D5 新增目标（派发/容量/重新分配/可替换任务管理/持续推进/运行形态）全部未实现 | 派发 01/02、计划交接 02、运行形态 01 |

## 对 02/03 的交接

- **02（调用方改造与旁路移除）**：只需转换 `apps/web/src/features/sessions/quick-start.ts`、`apps/web/src/api/client.ts`（集群侧，前置无）；`apps/web/src/hosts/local-session.ts` 与 Worker 本地创建链必须等 G-01 本地 Task 合同。集群侧"移除"实为收紧省略 `taskId` 的 root 创建并补负例断言，不是删除创建能力（差异 D-01）。
- **03（授权矩阵与签收）**：本表"已验证（本票）"仅到断言级，浏览器级证据需在具备 playwright/chromium 的环境补齐；"已验证（既有）"行需复跑或明确豁免；D5 与 G-05/G-06 缺口不得由 NEXT-03/04 历史完成覆盖。

## 复查方法

```bash
node scripts/migration-bypass-survey.mjs
node --import tsx --test apps/server/src/test/task-session-contract.test.ts apps/server/src/test/task-delete.test.ts apps/server/src/test/task-delete-artifacts.test.ts
node --import tsx --test apps/server/src/test/{task-runs,task-workspaces,session-workbench,tasks}.test.ts
node --import tsx --test apps/worker/test/local-workbench.test.ts
```
