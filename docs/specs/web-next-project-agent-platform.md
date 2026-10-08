# 新版前端与项目级 Agent 能力

状态：产品方向已确认；本文保留源码盘点与实施参考，正式中文 PRD 见 [Paperclip 风格前端重写与项目级 Agent 协作平台](web-next-project-agent-prd.md)，已登记为活动 Ticket 25（ready-for-agent）。决策见 ADR 0006、0007。存在入口不等于已验证有效；本文不是完成证明。

## 1. 目标与范围

以 Paperclip 前端为基础，在 `apps/web-next/` 重写 Wemux：保留许可声明，复用适合的应用壳、设计系统、基础交互，不搬旧页面或依赖 `apps/web`。可靠非 UI 逻辑经审计和行为测试后迁入共享模块。参考项目实际路径为 `research/paperclip/paperclip/`；参考版本在开始取用代码时固定 commit，并记录来源与改动。

平台在 Agent Runtime 之上：Task、Session、计划批准、资源访问及审查由平台定义，Runtime 自带 todo/Skill 不代替平台事实。内置 API 使 Agent 从项目视角工作，不只处理当前聊天文本。多入口共享应用服务和授权，按 Runtime 适配 Skill、CLI/API、MCP 或原生工具，不强制 MCP。迁移现有有效 Runtime，不把新增 Codex 纳入切换门槛。

所有现有有效功能必须迁移，不能静默裁剪。先 Server，再 Worker 独立宿主；架构从第一天支持双宿主，桌面与移动端均为交付要求。迁移期间同一部署实例根路径暂留旧版，`/next/` 提供新版，使用同一账号、数据和 Worker；旧入口不要求持续功能回归，历史旧版异常不作为新版交付门槛。集群浏览器不直接访问 Worker 控制接口；独立 Worker 有自己的鉴权。

## 2. 产品规则

- 所有 Session 必须绑定 Task，绑定后不换绑；一个 Task 可有多个 Session。普通实施 Task 属于 Project。
- 平台协调聊天使用 Team 级专用 Task，复用键为 Team + 用户 + Worker + Agent；项目内测试专用 Task 按用户 + Project + Workspace + Worker + Agent + 场景复用。Model 不参与复用键。
- 专用协调 Task 首次发送或上传时自动创建，长期复用，active/waiting 不是普通任务审查状态；重开上下文在原 Task 下新建 Session。不为专用对话引入普通 done/cancelled 流程。
- 同一 Session 可切换当前 Agent 的 Model；当前 Turn 固定执行快照，下一 Turn 使用新选择。不允许以改变模型为由丢失历史、隐式新建 Session 或切换 Worker/Agent；不支持时给出明确原因。
- 协调聊天用于讨论、研究、计划和交接，不直接正式实施。平台可选择任意获权 Worker 上的执行者，Server 本机也必须通过 Worker，不在 Server 内另起执行旁路。
- 不新增“创建实施任务”开关。纯讨论不派发；意图明确且获授权后可交接普通任务。要求先审计划时使用绑定 revision 的批准记录；交接计划快照不随新草稿自动变化，不对同一已授权范围重复审批。
- 交接创建普通任务并附带计划、验收标准和来源，不把它当作对话的子任务或阻塞对话等待执行。保存初始计划与任务应具备一致性，不能先启动再补计划。
- 普通任务显式提交完成，不以 Run/Turn 成功自动 done。项目默认不强制审查；任务继承项目策略，允许有管理权限的人覆盖为 Agent/人工/多阶段审查。执行 Agent 不可自行取消审查；执行中不隐式跟随项目默认值降低要求。
- Worker 本地也管理 Task；加入集群不自动上传本地数据或授予集群权限。本地任务管理不等于平台协调权限。
- 对话权限由运行时强制限制：读取/搜索/计划允许，代码修改、安装、部署及未授权外部写操作禁止。若 Runtime 无法可靠约束，不开放协调模式；不能只用 Skill 提示词伪装安全。

## 3. 内置 API 合同

下列为待落实的逻辑操作名，不是已交付 HTTP 路由承诺。先复用已有应用服务，再补缺少的端口；Web 用户身份与 Agent 的短期能力凭据分离。

| 能力 | 输入/结果要点 | 权限与一致性 |
| --- | --- | --- |
| project.list / project.get | 当前主体可见的项目、摘要和可执行操作 | 不返回不可见项目的标题、计数或路径 |
| project.resources | Repository、Workspace Placement、Worker/Agent/Model 可用性 | 可发现不等于可执行，逐资源授权，不携带 Secret |
| task.list / task.get | 项目内任务、状态、指派、计划版本、审查要求 | 有界分页、稳定排序、项目边界 |
| task.create | projectId、目标、验收标准、初始计划、来源、requestId | 明确创建权限；幂等键同体重试复用、异体冲突；创建不等于无条件启动 |
| task.sessions | taskId 下全部获权 Session 的分页投影，包括非 Run 启动的 Session | 按实际绑定查询，不仅拼接 runs；逐 Session 过滤，再分页/计数；有 Task 权限不自动取得私有会话内容 |
| session.get / session.events | 获权 Session 绑定、状态、标准事件与历史新鲜度 | 元数据权限与内容权限不混淆；游标补传与有界返回 |
| plan.save / plan.requestApproval | 文档版本 CAS、明确审批对象与批准记录 | 新 revision 不继承旧批准 |
| task.handoff / task.launch | 目标项目、任务指派、授权范围和固定计划版本 | 复用任务服务；不可跨 Team 越权，执行前重验 Worker/Agent/模型和授权 |
| task.submitCompletion / review.decide | 结果摘要、证据引用、预期版本、审查决定 | 按配置推进；拒绝自我取消必需审查，保留审计 |

Agent 调用上下文由宿主可信构建：实际操作者、当前 Task/Session/Invocation、资源范围、有效期和操作许可。不能信任 Agent 在 JSON 中自报的 userId、角色或项目范围。权限取用户授权、任务范围、工具能力与资源权限的交集；撤权后新调用拒绝，Token 不写提示词、Journal 或普通日志。

现有代码依据：`apps/server/src/http/routes/task-routes.ts` 已有项目 Task CRUD、Run、launch 和创建 Session；`session-routes.ts` 有会话事件与控制；`apps/worker/src/capabilities/pi-tools.ts` 有会话、Agent 消息、委派和连接器工具。它们尚不能证明上述项目级能力已完整暴露给所有 Runtime，尤其需新增并验证 task.sessions 的一致性与授权。

## 4. 功能迁移登记表

每行验收前须细化到操作级（来源路径、对应新入口、权限、正常/失败路径、证据），未知有效性不得记为完成。此表是源码盘点基线；逐页面/API核验发现的有效能力必须补入，不得按本表排除。

| 能力组 | 旧实现定位 | 新版验收内容 | 状态 |
| --- | --- | --- | --- |
| 启动/路由/账号 | app/host-paths.ts、landing、account-page、auth-link | 登录注册、验证、找回、OAuth、会话管理、邀请、深链接、CSRF、错误与重试 | 待核验迁移 |
| Team/资源权限 | team-page、project-access、worker-access、session-access | 成员角色、分享/Grant、撤权及内容过滤 | 待核验迁移 |
| 项目与工作区 | project-resources、create-dialog、creation-dialog | 项目创建与配置、仓库、Placement、创建失败重试、路径和文件边界 | 待核验迁移 |
| Task/Run/审查 | features/tasks、components/task-board | 列表/看板、详情、指派、活动、链接、Run取消、证据、可配置审查 | 待核验迁移及规则更新 |
| Session | features/sessions、hosts/session-journal、features/panels | 历史、流式/工具、队列、停止、审批、恢复、模型切换、用量和错误处理 | 待核验迁移及规则更新 |
| 画布/血缘 | features/session-canvas | 获权图、Fork、共享会话表面、布局、实时权限；Fork仍需任务归属 | 待核验迁移 |
| 文件/终端/成果 | features/files、terminal、artifacts | 浏览编辑Diff、终端、成果与审查；讨论模式不可绕过写权限 | 待核验迁移 |
| 待办/审批/活动 | features/attention、approvals、timeline、projections | 真实数据聚合、分页、状态新鲜度、动作授权 | 待核验迁移 |
| 集群/Runtime | cluster-page、worker-enrollment-dialog、features/agents | 注册、在线/失联、撤销、能力探测、安装说明 | 待核验迁移 |
| Skill/Preset/Provider | features/skills、presets | 发布/版本、作用域绑定、分发收敛、未验证模型不冒充可用 | 待核验迁移 |
| 连接器/Channel | features/connectors、channels | 配置、凭据、审批、投递失败/重试与权限 | 待核验迁移 |
| 本地 Worker | hosts/local-workbench、local-settings、local-cluster | 本地登录/Task/会话、凭据、Agent配置、入退集群及失败恢复 | 待核验迁移及本地Task新增 |
| 交互公共能力 | command-palette、components/ui、component-library | 导航搜索、键盘、弹窗焦点、未保存提示、移动端、HTTP安全降级 | 待核验迁移 |

## 5. 分阶段交付与硬门槛

1. **合同和盘点**：固定 Paperclip 来源、逐项核验上述登记表；建立 Task/Session/协调权限/API 行为测试，更新相冲突文档。不能以文档完成代表代码完成。
2. **Server 主闭环**：新目录与 /next 静态入口、登录、项目、Task绑定会话；协调计划→受权创建普通任务→实施→结果/审查；验证项目API与task.sessions。
3. **完整迁移与 Worker**：迁移所有有效功能，补本地Task及宿主隔离，覆盖现有有效 Runtime；手机与桌面同等验证。
4. **切换交付**：真实API/浏览器与真实Worker全链路验证、构建/打包/回退演练通过，再将新版设为根入口，删除旧代码与旧构建依赖；切换前只验证新版能力，不将旧版回归列为前置门槛。没有并行两套业务逻辑的长期方案。

真实验收至少覆盖：根首页与深链接登录前后、刷新/后退、过期登录、无权限、空态、弱网重连、重复提交、并发CAS、模型切换、撤权、取消竞态；桌面与手机完整操作而非截图。HTTP局域网随机ID/剪贴板降级必须保留。路由异常不得统一误报“链接无效”，需区分404、权限、接口失败与渲染异常。

API测试包括跨用户/Project/Task/Session越权、私有会话标题与计数泄漏、Worker独立/集群身份混用、Token过期与撤权、幂等异体冲突、计划批准版本过期、无审查与多阶段审查、Agent不能自己扩大范围。付费请求仍需授权，模拟可补充回归但不替代真实验收。

## 6. 数据重置与部署

用户允许历史应用数据全部清理且无需保留旧记录，不做旧会话补绑迁移。执行前列出实际路径和影响范围，备份数据库、传输状态与必要配置；成组停止服务、清理对应应用数据、重建登录及Worker身份、验证在线与新任务会话。不得只清Server保留旧注册重放队列；不得误删工作区源码、外部仓库、Agent全局认证或其他应用数据。数据重置与旧前端删除是两个门槛：允许先清数据不代表能提前删除旧前端。沿用现有唯一管理入口，避免另建部署实例或新旧二进制混用。

## 7. Paperclip 参考证据与不照搬项

- `ui/src/pages/Projects.tsx`、`ProjectDetail.tsx`：项目排序、任务/工作区/配置组织；不直接映射其 Agent 为 Wemux Worker。
- `ui/src/pages/AgentChat.tsx`、`server/src/routes/issues.ts`、`packages/db/src/migrations/0274_agent_chat.sql`：聊天专用Issue、懒创建、固定身份；Wemux改为Team归属及Worker绑定。
- `server/src/services/agent-conversations.ts`：计划交接指引与active/waiting；指引本身不等于运行时强制隔离。
- `server/src/services/issue-execution-policy.ts`：可选多阶段审查；不把进程正常退出当任务验收。
- `skills/paperclip/SKILL.md`、`packages/adapters/*/src/server/execute.ts`：Skill/API及按Runtime注入，MCP不是唯一通道。

未实现的未来路线（真实模型认证、额外Runtime、企业连接器等）保持各自状态，不用此次前端重写宣称全部交付，也不无边界扩入切换门槛。
