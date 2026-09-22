# Wemux Lite 产品建设路线图

状态：功能与交互优先的修订计划。依据用户反馈，现有基本流程能跑通；不再将全面稳定性核验作为功能建设前置。这不是对所有异常路径已通过验收的声明。

依据：[产品方向](product-direction.md)、[领域术语](../CONTEXT.md)。本文 M0–M8 是当前阶段编号，与旧任务改造、运行时重构文档的内部编号无关。

## 1. 优先级原则

1. **先补用户每天使用的功能与交互**：整体导航、直接会话、项目工作环境、集群管理，再完善任务协作、团队共享和运维。
2. **先设计主路径，再按切片落地**：设计不只是换皮；每项明确入口、操作、状态、结果和后端缺口。已有可用能力复用，不因文档重排而重写。
3. **验证随功能走**：测试、安全检查、浏览器验收与失败恢复是每个切片的一部分，不单独安排全面核验阶段阻挡开发。已知的数据丢失、越权、重复执行等阻断问题仍优先处理。
4. **不要制造串行依赖**：会话优化复用已有节点和环境能力，不必等所有集群管理、多仓库或团队功能完成。明确不可用组合，而不是静默降级。
5. **目标与现状分开**：用户确认基本流程可用；新增功能仍需实现与验收。仅有类型、按钮或原型不能算已交付。
6. **轻量架构不变**：必要依赖、单 Server 默认形态与本机 Agent 执行继续保留，不以“完善产品”为由引入不必要的中间件。
7. **能力分层、Module 深化**：领域事实、应用编排、宿主端口、基础设施 Adapter 和 UI 投影单向依赖。每个 Module 通过小 Interface 隐藏事务、恢复、权限和 Provider 差异，调用方与测试走同一 Seam。
8. **可插拔必须有真实变化点**：Pi/OpenCode、Server/Worker 宿主是现有真实 Adapter；React Flow 先封装在单一画布 Adapter 中。没有第二种实现前不预建插件市场、任意关系注册表或通用布局框架。

## 2. 新的里程碑顺序

| 阶段 | 优先级与用户价值 | 主要依赖 | 当前状态 |
| --- | --- | --- | --- |
| M0 定位与文档 | 统一产品方向与领域语言 | 无 | 文档已编写 |
| M1 功能补全与交互设计 | 先确定缺什么、页面如何组织、关键操作怎么走 | M0 与现有可用流程 | 已完成首轮设计并进入实施 |
| M2 双宿主会话工作台 | 集群会话体验、Worker 独立 Web/鉴权及主动加入集群 | M1 双宿主设计、已有执行能力 | 已完成：W1/W2/W3 已实现并通过自动化与本机 HTTP 冒烟 |
| M3 项目与工作环境 | 统一组织项目、会话与多 Worker 环境 | M1 环境设计、已有 Placement 能力 | 未开始 |
| M4 集群与能力管理 | 完善 Worker、Agent、模型的管理与诊断体验 | M1 集群设计；与 M2/M3 共用选择契约 | 未开始 |
| M5 任务协作与交付 | 完善目标、指派、运行、审查与成果追踪 | M2/M3，复用现有执行能力 | 未开始 |
| M6 账号、团队授权与开放客户端 | 本地注册、Google 登录、多用户共享、资源权限、PAT 与审计 | 账号线 A0–A3；安全设计提前贯穿 | 账号线 A0–A3 已交付：Ticket 15 完成停用、销号、认证版本与可筛选/导出安全审计；新增搜索/最近工作/下载入口授权仍需随各功能实施 |
| M7 运维与正式发布 | 升级、备份、恢复、容量与发布验收 | M1–M6 交付及跨阶段回归 | 未开始 |
| M8 受控自动化 | 能力推荐、批量分派和多 Agent 协作 | M7，另行确认投入 | 后续增强 |

默认投入顺序为 M1 → M2 → M3 → M4 → M5 → M6 → M7，M7 是完整产品发布线。M8 不作为无限推迟发布的理由。

Agent Network 近期采用独立的纵向优先级，不改变上述产品阶段编号：

- **P0 公共执行协议收敛（已完成）**：`@wemux/domain` 拥有 `wemux.adk.v1` 与公共值对象；`@wemux/agent-interchange` 的 `AgentEvent` 是唯一公共执行 Event；Provider signal → AgentEvent → Session Journal → transport 是单向转换链；Transport v2 仅引用 Profile；已删除未接入生产的第二套 RuntimeEvent / compatibility / wire parser。
- **P1 真正支持多 Agent（当前优先，Pi + OpenCode）**：实现 OpenCode 检测、配置、运行时 Adapter 与安装生命周期；用真实 Pi/OpenCode 验证同一 AgentRunner/AgentEvent 合同；形成 resume、tool、approval、usage、cancel、structured output 能力矩阵，并补双 Agent 真实验收证据。
- **P2 团队协作与 Agent Network 编排**：在稳定的单 Agent 语义上增加委派、handoff、父子 invocation、跨 Worker 路由、审批、预算、取消传播和审计；保持直接对话无需任务看板。

会话协作画布采用独立 C0–C6 纵向线，详细合同见 [会话协作画布与血缘模块设计](design/session-collaboration-canvas.md)：

- **C0 模块合同与依赖门**：冻结 Session Fork、图读模型、Session Surface 状态所有权及 Domain → Application → Host Adapter → Presentation 的依赖方向；禁止 React Flow 类型进入领域/Server 契约。
- **C1 Fork 与血缘权威**：交付固定 `sourceEventCursor`、目标 Session 原子创建、幂等、权限收窄、审计、祖先/后代查询；先完成 API 和测试，不依赖画布 UI。
- **C2 基础协作画布（已完成，Ticket 18）**：`@xyflow/react` 只存在于 Canvas Viewport Adapter；已交付权威图投影、摘要节点、Fork 边、选择、平移缩放、确定性默认位置、本机 revision 隔离布局和失败回退。URL 深链/返回恢复、Server CAS 布局、移动端专用降级及 100 节点预算按 Ticket 22 收口。
- **C3 交互 Session Surface**：画布节点可直接对话，与专注视图共享草稿、Journal、队列和控制状态；复用现有 `framer-motion` 完成最大化/缩回及 viewport/scroll/focus 恢复。
- **C4 授权实时同步与撤权**：交付权威图增量、最小 Presence、cursor 缺口恢复和打开中实时流撤权；不被团队布局阻塞。
- **C5 布局持久化与大型图性能**：交付个人/团队布局、冲突保护、性能基线与预算；只有实测需要时动态引入 `elkjs`。
- **C6 编排关系与开放接口**：先按 Ticket 23 冻结 Delegation、handoff、Artifact Reference、Run Attachment 合同，再由 Ticket 21 投影到图；CLI/SDK/外部自动化调用同一 Application Interface。

C0/C1 可在账号线继续推进时独立实施；C2 依赖 C1 稳定图契约，C3 依赖现有双宿主 Session Runtime，C4 的不互信团队实时能力依赖 A3，C5 依赖 C2/C4，C6 依赖 Ticket 23 的 P2 合同。画布不是 P2 编排的前置条件，P2 也不应把领域状态塞进画布实现。

这不是要求所有阶段全量串行完成：M1 的会话设计确认后即可实施 M2，其余页面继续细化；M3/M4 的共享执行目标选择先定契约。M5 先在受信管理员范围交付任务功能，多成员评论、提及与通知待 M6 权限门槛通过后开放。不互信用户共享必须等待 M6。

### 账号与身份线（A0–A3，独立优先级）

账号系统是近期必需能力，包含邮箱密码注册、验证与找回、Google OAuth/OIDC 注册和登录、显式账号绑定与团队加入。完整设计见 [账号、注册与 Google 登录](design/account-identity-system.md)；其中 A0 已按验收摘要交付，A1–A3 仍是待实施设计，不能把目标表格整体当成实现声明。A 编号与 M 阶段并行；A3 是不互信用户共享与 P2 委派的授权门槛。

现状（已核对代码）：

- 已交付（A0.1，Ticket 04）：实例管理员由部署声明 `WEMUX_ADMIN_EMAILS` 决定（大小写不敏感、命中即管理员，审计 `instance.administrator_assigned`；声明邮箱不受邀请制/关闭限制，仍需自己注册并验证邮箱）、独立 `login_sessions` 表与 HttpOnly Cookie 会话（CSRF、Origin 校验、空闲/绝对过期、限流、设备会话列表与撤销）、`node dist/cli.js credentials` 主机本地恢复、秘密屏蔽回归。引导令牌、`instance_claim` 与 `POST /auth/setup` 已从代码移除，旧实例重写历史归属未实现。设计与实现形态见 [账号、注册与 Google 登录](design/account-identity-system.md) 第 5.1 节，验收摘要 [部署者即管理员](acceptance/account-identity-deployer-admin.md)。
- 已交付（A0.2，Ticket 05）：邮箱密码注册与重发、邮件验证、忘记/重置密码、`open | invite_only | closed` 注册策略（默认仅邀请，实例管理员可改并审计）、SMTP 与本地出件箱投递、反枚举与分维度限流、邮件链接站内确认页（扫描器 GET 不消耗凭据）。实现形态见同文档第 5.2 节，验收摘要 `evidence/05-email-registration-and-verification.md`。
- 已交付（A0.3，Ticket 07）：Google OIDC 注册与登录（Authorization Code + PKCE S256、一次性 state/nonce、`jose` 验签与声明校验、失败一律 302 带 `oauth_error` 回落地页）、`login_identities` 按 `(issuer, subject)` 唯一绑定、同邮箱不自动合并、第三方邮箱权威边界、客户端秘密不进审计与日志。实现形态见同文档第 5.3 节，验收摘要 `evidence/07-google-registration-and-login.md`。
- 已交付（A0 安全收口，Ticket 06/08）：密码与邮箱自助管理、强认证与撤销面、Google 身份显式绑定/解绑、最后一种登录方式保护、Google-only 账号设置本地密码；账号安全页已提供密码、邮箱、登录方式与设备会话四个分区。实现形态见同文档第 5.4–5.5 节，验收摘要 [账号安全与登录方式](acceptance/account-identity-security-and-linking.md)。
- 已交付（A1 第一纵向切片，Ticket 09）：Team 创建/选择、owner/admin 邮箱定向邀请、撤销、已有账号接受、无账号邀请注册并在邮箱验证事务中加入；邀请令牌哈希持久化、重启可恢复、并发单次消费、邀请者权限重检。验收摘要：`.scratch/product-convergence/evidence/ticket-09-team-creation-and-invitations.md`。
- 已交付（A3 第一纵向切片，Ticket 10）：Project 的 owner/viewer/contributor/manager 授权闭环、`owner-only | selected-members | team` 共享范围、跨 Team Grant 拒绝，以及 Project/Workspace/Session/Task 公开读取和 Task 写入的服务端授权。验收摘要：`.scratch/product-convergence/evidence/ticket-10-project-authorization.md`。
- 已交付（A3 第二纵向切片，Ticket 11）：Worker 的 `owner | use | manage` 授权、`owner-only | selected-members | team` 共享范围、跨 Team Grant 拒绝，以及 Worker 列表/能力目录/Placement/Session/Run 的 Project×Worker 权限交集。验收摘要：`.scratch/product-convergence/evidence/ticket-11-worker-authorization.md`。
- 已交付（A3 第三纵向切片，Ticket 12）：Session 的 `owner-only | selected-members | project` 共享范围、Session Grant、read/write/control 分离、Workspace/Task 默认范围、消息/Turn/Approval 真实操作者，以及列表/详情/Journal/SSE/执行控制的统一授权。验收摘要：`.scratch/product-convergence/evidence/ticket-12-shared-session-operator-permissions.md`。
- 已交付（A1/A3 治理收口，Ticket 13）：Team 角色调整、成员移除、显式所有权转移与最后 Owner 保护；Team/Project/Session 授权变更会使活跃 SSE 重授权，成员移除为受影响未完成 Run 写入幂等 `run.stop`，离线 Worker 保留待送达命令，后续投递重新检查 Project×Worker×Session 权限交集。验收摘要：`.scratch/product-convergence/evidence/ticket-13-member-governance.md`。
- 已交付（A2 第一纵向切片，Ticket 14）：设备会话列表/单个撤销/退出其它设备；PAT 名称、`read | write | execute | admin` scope、到期、一次性明文、列表、撤销、原子轮换、脱敏审计和 SSE 周期重鉴权。验收摘要：`.scratch/product-convergence/evidence/ticket-14-pat-and-device-sessions.md`。
- 已交付（A2/A0 生命周期收口，Ticket 15）：账号停用/恢复、销号前所有权门、去标识与外部身份墓碑、认证版本即时失效、可筛选 cursor 审计与同权限 NDJSON 导出。验收摘要：`.scratch/product-convergence/evidence/ticket-15-account-lifecycle-and-audit.md`。
- 仍未实现：新增搜索/最近工作/下载入口授权（随对应功能切片实施）。
- 类型与存储入口成套：`packages/server-domain/src/identity.ts`（`User`/`Team`/`Membership`/`LocalAccountCredential`/`TeamRole`）、`access.ts`（`WorkerGrant`/`ProjectGrant`/`SessionGrant`、`ResourceShareScope`/`SessionShareScope`）、`credentials.ts`（`PersonalAccessTokenRecord`/`EnrollmentTokenRecord`/`WorkerCredentialRecord`）、`audit.ts`（`AuditEntry`）；`ServerIdentityReader`/`ServerIdentityWriter` 读写方法齐备。
- 身份实体可复用通用 `records(kind,id,data)` KV 表，但邮箱/外部身份唯一约束、记录版本和旧会话/PAT 退役仍需升级设计与恢复演练，不能据此承诺无迁移。Ticket 04 的升级路径已用 `apps/server/src/test/account-upgrade.test.ts` 锁定：旧实例管理员归属保留，歧义时报告 `ambiguous_administrator` 而不是自动接管。
- Worker 宿主已有可用本地账号实现（`apps/worker/src/application/local-installation.ts`，scrypt + 盐 + `timingSafeEqual`），且不读 Server 账号库（回归：`apps/worker/test/host-isolation.test.ts`）。
- Grant 执行点已覆盖 Project、Worker 与 Session 的现有列表、详情、执行及实时入口；新增搜索、最近工作、下载和通知入口时仍必须走同一 Application 授权服务，不能回退为路由层散落判断。

- **A0 账号、注册与登录（前置，已交付）**：A0.1 身份/登录会话与升级、A0.2 邮箱密码注册/验证/找回与 SMTP、A0.3 Google OIDC 注册/登录，以及 Ticket 06/08 的密码/邮箱安全管理与登录方式显式绑定/解绑均已交付。稳定 User 与登录方式分离，外部身份按 `(issuer, subject)` 唯一，不凭同邮箱自动合并；Web 登录会话独立于 PAT 与对话 Session；支持 `open | invite_only | closed` 注册策略，登录安全、CSRF、限流、邮件与 OAuth 一次性事务已随 A0 落地。Wave A/B/C 跨票据验收均通过。仅真实 Google 公网部署实测仍受合规 HTTPS 域名、Client 配置与测试账号阻塞，不等于绑定入口未实现。
- **A1 Team 与成员（已交付）**：Ticket 09 已交付 Team 创建/选择、邮箱定向邀请/撤销/接受、成员列表与无账号邀请注册；Ticket 13 已交付成员角色调整、移除、显式所有权转移与最后一个 Owner 保护。邀请消费、成员建立、治理变更、审计与受影响 Run 的停止命令均保持事务一致性；注册不自动加入 Default team 或授权已有 Worker。
- **A2 凭证管理与安全完善（已交付）**：Ticket 14 已交付 PAT 签发/列表/撤销/原子轮换、`read | write | execute | admin` 作用域与设备会话；Ticket 15 已交付账号状态/认证版本、停用恢复、销号去标识、外部身份墓碑，以及可筛选 cursor 审计和同权限 NDJSON 导出。旧无 scope PAT 失效后重签，不猜测旧权限。日志与审计不记密码、Token、OAuth code 或完整聊天。
- **A3 授权执行点穿透（Ticket 10–13 已交付闭环）**：Project、Worker、Session 三层 Grant 与 ShareScope 已接入现有读写、Journal、SSE 和执行控制，执行取权限交集并保留真实操作者；成员移除会原子撤销入口、关闭已打开实时流并为进行中 Run 写入可恢复的停止命令。新增搜索/最近工作/下载入口时仍须补同一授权门。

A0 与 M3/M4 可并行，A1/A3 需共同定义成员与资源授权契约；A0 单独完成只允许受控验收，A3 未验收前不得开放不互信多用户。Google 首版在 Server 配置，Worker 保留独立本地账号，不自动共享登录身份或本地会话。Google 实测需合规 HTTPS 域名、Client 配置与测试账号；未配置只标真实验收阻塞，不以模拟测试宣称已支持。

### 与上一版的变化

- 原 M1“可信运行基线”取消为独立前置阶段；相关验证并入功能验收，系统性恢复与发布演练归 M7。
- 会话工作台从原 M4 提到 M2，优先解决日常操作。
- 项目环境保持 M3；节点与能力管理从原 M2 调整到 M4，现有检测和选择能力继续支撑前面阶段。
- 任务协作从原 M6 提到 M5；团队授权从原 M5 调整到 M6，但不推迟新增接口的必要鉴权。
- 旧提案不是已执行工作；新编号不继承旧阶段的完成声明。

## 3. M0：定位与文档

已编写产品方向、术语表、使用指南和历史规格适用范围。继续维持两条一等路径：直接对话 `Project → Workspace → Session`，任务协作 `Task → Run → Session → Review`。

公共执行协议已完成 P0 收敛；下一步多 Agent 验收明确优先 Pi 与 OpenCode。Claude Code 保留现有兼容能力，但不替代 P1 的 Pi + OpenCode 基线。

文档变更不代表功能交付；旧幂等、取消、权限和历史新鲜度规则不因重新排期而失效。

## 4. M1：功能补全与交互设计

**目标**：基于现有可用系统和外部原型灵感，明确产品缺口及下一批可实施的交互规格，而不是先跑一轮全面稳定性审计。

设计顺序与工作切片：

1. **功能清单与导航**：快速对照现有页面，列出已有、需补充、需调整的功能；确定全局导航、项目内导航、最近工作、搜索与详情面板边界。
2. **会话主路径优先**：新建会话、执行目标选择、会话列表、时间线、工具展示、输入与队列、停止、运行详情；先形成可实施方案，不等待所有页面设计完。
3. **项目与环境**：项目入口、Workspace 列表/详情、节点副本、创建与定向重试；共享文件和固定执行绑定的提示位置。
4. **集群管理**：Worker 列表/详情、注册引导、Agent/模型清单、不可用原因、管理操作及操作反馈。
5. **任务与设置**：任务列表/看板、Run/Review，团队与权限管理的预留结构，不让任务成为对话前置。
6. **交互状态与开发拆分**：桌面/手机、加载/空态/失败、危险操作确认、键盘操作；记录需新增的 API/DTO、迁移和逐项验收场景。
7. **Worker 独立宿主**：首次本机身份初始化、Web 登录、本地环境/Agent 选择、可选集群连接向导及退出；设计公网安全配置与双入口归属，不要求先加入集群。
8. **会话协作画布**：定义 Session Surface、固定 cursor 的 Fork、血缘图、画布/专注连续切换、权限过滤、布局持久化和移动端降级；画布不是自由白板或浏览器编排器。
9. **模块合同**：为画布、血缘、运行时、授权和编排分别声明 Interface、依赖方向、状态所有者与测试表面；只有真实多 Adapter 的 Seam 才允许做成可插拔点。

交付物：

- 已编写 [页面与功能优先级及开发切片](design/feature-interaction-plan.md)，状态为待确认设计提案。
- 已编写 [Wemux 源码对照报告](research/wemux-m1-feature-interaction.md)，区分源码事实、借鉴边界与 API 缺口；未做浏览器比较或实现验收。
- 主路径线框或交互稿，以及外部原型的采纳/调整说明；无外部原型时可以先用流程和线框推进，不被工具产物阻塞。
- M2 首批开发切片与验收清单，其余阶段逐步细化，不提前冻结全部细节。

设计退出门槛：明确页面入口、主要操作、状态与结果；区分已有能力和待开发目标；用户确认会话主路径即可进入 M2。M1 本身不要求真实 Agent 冒烟或全量故障注入，原型也不算实现验收。

## 5. M2：双宿主会话工作台与日常对话

**目标**：先把最常用的“找到会话、开始工作、监督结果、继续工作”做顺手，同时支持独立 Worker 和集群两种宿主。

新增方向见 [Worker 独立 Web 工作台](design/worker-web-workbench.md)：Worker 无需注册即可安装启动；自身认证支持显式公网 HTTPS，通过 Web 主动加入集群。M1 先确认共享模块和权限边界；M2 以 W1 独立身份/启动 → W2 本地安全 Web 与共用会话 → W3 注册/连接/退出推进，与原 S1–S6 共享实现。单管理员公网安全不能等到 M6/M7；完整多人协作仍归 M6。本地会话默认不上传，接管/发布和委派另定规格。

M2 范围因此扩大，W2 独立工作台和 W3 集群接入分别验收，不以完成原 S1–S6 宣称全阶段交付。包拆分按两个真实宿主的需要渐进进行，不先大规模重写运行时。

优先交付：

1. 会话搜索/筛选、按工作区组织、最近会话、重命名与归档；选中状态与 URL、浏览器前进后退一致。
2. 新建会话的 Workspace/Worker/Agent/Model 级联选择、默认值与不可用原因；老会话更换执行绑定时明确新建。
3. 消息与工具时间线、折叠输出、代码块、错误、执行摘要；区分提交、排队、执行与终结。
4. Composer 草稿、连续提交、队列查看/逐条取消、停止当前回合；运行期间仍可编辑，响应不明确时重试复用身份。
5. 运行详情与次级信息：用量、模型、执行位置和同步状态；浏览器连接与 Worker 离线分开显示。

后续同阶段切片：可用原生命令、附件支持矩阵与限制、长历史分页、必要的原生上下文恢复和运行时回收。已有实现直接接入；仅为产品能力需要修补运行时，不启动无目标重构。

M2 已交付的双宿主会话能力作为 C3 的运行时基础，但不据此宣称画布已实现。C3 必须复用同一 Session Runtime/Journal/Composer 状态，禁止另建“画布聊天”状态机。

交付：会话工作台、所需 API/Worker 补充、桌面和窄屏行为测试。

验收：用户可不建任务完成新建、连续对话、查看工具、排队、停止及重新进入会话；独立消息不串入 Run。涉及恢复、附件、原生命令的改动按实际 Agent 支持验证，缺失用量不填零冒充数据；进程复用不得沿用过期授权。真实 Agent 测试记录版本和环境，费用事先批准，跳过不标通过。

## 6. M3：项目与跨 Worker 工作环境

**目标**：项目、工作区和会话的组织关系可理解，各节点副本可管理。

优先交付：

1. 项目列表/切换、概览、最近工作和归档；直接对话与创建任务双入口。
2. Repository 和 Workspace 创建流程，明确代码来源、修订、目标 Worker；减少重复输入。
3. Workspace 详情聚合各 Placement 的路径、状态、错误与会话；添加节点副本、定向重试和清理。
4. 共享目录、独立环境、删除影响范围的解释；离线清理如实等待，不直接擦除项目关联文件。

后续同阶段切片：多仓库 Composite Workspace，先定专用成员所有权、同 Worker 物化及部分失败/清理契约，再开放入口。基础环境管理不被多仓库功能阻塞。

交付：项目与环境页面、Placement 契约统一、必要迁移与多节点验证。

验收：A 就绪/B 失败时，选择 B 被拒绝且能定向恢复；重试/清理 B 不破坏 A；旧单 Worker 数据不丢绑定；删除操作可追踪。跨 Worker 不暗示文件同步或 Session 迁移；Composite 部分成功不可假装整体就绪。

## 7. M4：集群、Agent 与模型管理

**目标**：从“知道节点在线”升级到“知道能做什么、有什么问题、如何处理”。

优先交付：

1. Worker 列表、筛选、详情；连接、版本、执行负载、环境和运行会话可追溯。
2. 注册节点引导，安装/注册/连接/能力上报分步反馈，复制失败有手动降级。
3. Agent 能力与模型目录；明确未安装、未认证、仅检测、可执行，以及刷新时间和操作支持。
4. 重检、重命名、诊断、撤销、身份恢复和凭据轮换；维护模式不接新执行，并说明已有执行处理方式。
5. 本地 Agent 路径/显式安装的管理指引；远程安装如开放，须限定固定允许包、授权与进度，不开放任意 shell。
6. 按 [Worker 可靠长连接模块设计](design/worker-reliable-connection.md) 分切片完善单连接状态机、transport/ADK 独立协商、持久 outbox/inbox、ACK、背压、重连诊断与 Journal cursor 恢复；近期继续使用原生 WebSocket 和 SQLite，不引入独立 Broker。

交付：集群管理页面、节点生命周期和能力矩阵、诊断与管理 API，以及不会改变 Wemux ADK Profile 对话契约的可靠连接基础能力。

验收：至少两个 Worker 的身份、能力和会话不串用；模型消失不静默替换；仅检测 Agent 不允许启动。Pi/Claude 作为执行基线，Codex/OpenCode 的执行适配另定规格和测试，不能因可检测而宣称可执行。新连接替换旧连接时，旧 socket 的迟到关闭不得把 Worker 标记离线；网络重试不得改变 `messageId`、`invocationId`、Event `id` 或管理 `commandId`。系统性断网、重启、磁盘与大规模重连演练仍在 M7 汇总验收。

## 8. M5：任务、审查、成果追踪与会话血缘

**目标**：在直接对话之外补全可选的任务闭环，并建立可独立于任务使用的 Session Fork/血缘权威；不先建设完整团队系统才允许完善任务体验。

优先交付：

1. 任务列表/看板、搜索筛选、目标与验收标准；拖拽有状态菜单替代。
2. Assignment、Run 历史、reuse/new、新尝试与取消；快照、幂等和独立消息归属清楚。
3. Review、要求修改、重新执行、结果证据与变更/提交/PR 关联，不由 Agent 自报决定完成。
4. 外部 issue/PR 关联与受控导入；写回与读取分开授权，写回预览/确认及重试幂等。
5. 按 C0/C1 交付 Session Fork 与血缘查询：固定来源 cursor、目标 Session 原子创建、独立 Journal、明确执行绑定、权限收窄和审计；Task/Run 可以关联这些 Session，但不拥有其生命周期。
6. C2 基础协作画布已交付：Project 概览展示获权 Session 摘要、Fork 边、选择、pan/zoom、MiniMap、确定性默认位置和本机视图状态；列表与专注会话保持完整替代入口。URL 深链/返回恢复、个人/团队布局、冲突保护、移动端专用降级与大型图预算归 C5/Ticket 22。

多人责任归属、评论、提及与通知先设计，随 M6 授权实现后开放；不要把执行 Assignment 混同人类责任人。既有任务契约见 `docs/design/task-platform-contract-decisions.md`，画布与血缘合同见 `docs/design/session-collaboration-canvas.md`。

交付：受信管理员可用的完整任务/审查体验、外部关联与证据记录、Session Fork/血缘权威、基础协作画布及后续多人协作契约。

验收：完成指派 → 执行 → 要求修改 → 新尝试 → 人工完成；改指派不改历史；取消不影响其他消息；外部写回重试不重复。Fork 重试不重复创建目标 Session，来源 cursor 后的消息不进入目标，画布边与 API 血缘一致。多人通知、实时协作与私有内容隔离在 M6/C4 联合验收，不提前宣称已支持。

## 9. M6：账号、团队授权、安全与开放客户端

**目标**：完整支持本地注册、Google 登录与账号生命周期，并提供有明确边界的团队共享；Web 与其他客户端一致受控。

工作切片：

1. 邮箱注册/验证/找回、Google OIDC 注册/登录/绑定、登录退出、账号生命周期、Team 邀请与成员、所有权转移与最后一个 Owner 保护；bootstrap 不作为日常共享万能凭据（设计见账号线 A0/A1）。
2. Worker/Project/Session 的独立共享策略与 Grant；执行取权限交集，治理身份不自动读取私人内容（实现见账号线 A3）。
3. 列表、搜索、详情、下载、通知、SSE 与执行的统一授权和撤权；明确进行中执行的撤权/停止策略（实现见账号线 A3）。
4. PAT 作用域、到期、撤销与轮换；公共 API、事件、分页、幂等、错误和版本文档，提供 CLI/脚本示例（实现见账号线 A2）。
5. 安全会话、TLS、CSRF 等对应防护、限流与审计；承接 M5 多人责任分配、评论和通知。
6. 按 C3/C4 完成共享 Session Surface、画布内直接对话、最小 Presence、授权图增量与撤权；无权节点、标题、摘要、关系和实时事件均不得侧漏。个人/团队布局、冲突保护与大型图性能作为 C5/Ticket 22 独立验收，不阻塞实时撤权闭环。

交付：用户/成员/授权/凭证/审计界面、客户端指南、安全矩阵与协作验收。

验收：两个 Team、多角色和私人/共享资源实测；跨团队访问、残留 Grant、搜索侧漏、已打开 SSE 的撤权均正确处理；Web/CLI 权限一致，审计不复制 Token 或完整聊天。M6 前仅面向受信管理员，不能向不互信用户开放共享。

## 10. M7：运维、系统性验证与正式发布

**目标**：在功能完整的基础上集中验证长期运行、升级和恢复，不再提前阻挡交互补全。

工作切片：

1. 干净机器安装、服务托管、卸载和数据保留；产物校验及协议/版本兼容矩阵。
2. 升级前备份、Worker 排空、兼容检查与批准；不可逆数据库迁移必须有备份恢复方案，不把回退代码当作回滚数据。
3. Server 与 Worker 独立备份恢复、Journal/文件/原生上下文保留、磁盘不足处理；Worker 丢失后缓存保持非权威只读。
4. 系统性故障注入：响应丢失、重复提交/回执、断线补传、取消竞态、Server/Worker 重启与执行状态收敛。
5. 浏览器兼容、生产构建/缓存/启动、长历史和负载验证，健康、日志、指标、诊断包与故障手册。

交付：运维与升级手册、可重复脚本、容量/支持环境矩阵、发布候选报告。执行票为 `.scratch/product-convergence/issues/24-release-readiness-and-recovery-gate.md`。

验收：对固定 commit 和候选构建执行 Ticket 24；安装、旧版本升级、升级失败、两端恢复及 Worker 永久丢失分别演练；报告真实 RPO/RTO 和负载，不承诺未验证的恢复时间。M1–M6 跨阶段回归与已支持 Agent 冒烟通过；已知阻断缺陷清零，非阻断风险有发行说明与后续票据。

## 11. M8：受控自动化

**目标**：在可靠授权与执行基础上减少人工分派。

工作切片：可解释的能力/环境/负载匹配推荐，批量任务与依赖，并发/预算/超时/审批限制，持久调度，多 Agent 最小 capability 与父子执行追踪，防消息循环与取消传播。

验收：重启不重复执行，权限和预算不能绕过，部分失败可定位；断线不视为原执行已停止，重试或重新放置需安全证明或人工确认。自动化不能自行标记 Task done。范围在 M7 后按真实需求再确认。

## 12. 排期与共同完成定义

- **滚动排期**：先细化 M1 会话设计与 M2 首批切片，开工时填责任人、估算和日期，不虚构人员与工期。原型反馈可迭代，不无限等待全部页面定稿。
- **设计完成**：入口、流程、正常/等待/失败/恢复状态、数据需求与验收场景明确；不以静态截图代表功能完成。
- **实现完成**：相关 Web/API/Worker 及迁移闭环，必要鉴权和错误处理同步交付，无假按钮或模拟成功。
- **切片验证**：类型检查、相关测试及真实浏览器操作；按改动风险覆盖队列、重试、断线、取消、权限或清理，不每次重跑所有故障场景，也不全部推迟到 M7。
- **Module 验收**：调用方与测试必须从公开 Interface 穿过同一 Seam；不得用直接读数据库、React Flow 内部对象或 Provider 原生事件替代行为验收。删除 Module 后若复杂度不会重新散落到调用方，应合并或删除该浅 Module。
- **依赖门**：`@xyflow/react` 只进入前端 Canvas Viewport Adapter；`framer-motion` 继续用于呈现动画；`elkjs` 只有性能/布局证据和第二种布局实现需求时才引入并动态加载。
- **证据**：`docs/acceptance/mN-<topic>.md` 记录版本、环境、命令、实际结果、失败/跳过和残余风险；原始制品放 `.scratch` 或受控 CI，摘要脱敏、脚本可复跑。实际执行时再创建报告，不能预填通过。
- **阶段状态**：未开始、设计中、实施中、待验收、已验收、阻塞；只有指定版本通过对应门槛才标已验收。基础可用的用户反馈不替代新增功能的验收。
- **性能**：随会话、环境、任务切片记录相关交互耗时；M3 至少双 Worker，M2 长历史与多会话，M5 100+ Task，M7 验证声明支持规模，避免凭功能数量推断容量。

## 13. 下一轮安排

1. 已完成本轮源码差异盘点和功能分类，参见 M1 调研报告；不重复开展全面基线审计。
2. 评审交互初稿的全局导航、会话区域分工与执行位置选择；确认后实施 S1 导航、S2 Placement 选择、S3 统一输入。
3. 原型到稿后对照评审；无原型也可用已编写线框推进，不阻塞所有设计。
4. 按 S4 队列/停止、S5 时间线/详情、S6 查找/重命名继续纵向交付；环境、集群页面逐步细化。
5. 现有或新增阻断问题按证据处理；历史 Web 启动提示仅在仍可复现或阻碍当前路径时优先修复，不再作为默认前置任务。
6. 账号线 A0 已走完 A0.1（Ticket 04）/A0.2（Ticket 05）/A0.3（Ticket 07），并以 Ticket 06/08 完成密码/邮箱安全管理及登录方式显式绑定/解绑；Wave A/B/C 跨票据验收均通过（`apps/server/scripts/verify-wave-ab.mjs`、`verify-wave-c.mjs`）。A1 的 Team 创建、邀请与成员治理（Ticket 09/13）、A3 的 Project/Worker/Session 授权与实时撤权（Ticket 10–13）、A2 的 PAT、设备会话、账号生命周期与可筛选审计（Ticket 14/15）已交付；下一步回到产品主线的新增搜索/最近工作/下载授权或后续正式票据。采用 [账号系统设计](design/account-identity-system.md) 的交互与验收矩阵；真实 Google 部署实测仍需合规 HTTPS 域名、Client 配置与测试账号，未配置时只标注真实验收阻塞。
7. 画布线先执行 C0 模块合同，再执行 C1 Fork/血缘权威；两者不改现有 UI 依赖。C1 稳定后才安装 `@xyflow/react` 推进 C2，避免先画静态假图后补领域语义。
8. C3 已通过 Ticket 19 复用双宿主 Session Runtime，实现同一 Session Surface 的画布交互、摘要缩回与专注往返；C4 等待 A3 权限门，C5 独立验收布局性能，C6 先完成 Ticket 23 编排合同再推进 Ticket 21 投影。
