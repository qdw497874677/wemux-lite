# 新版操作级迁移登记（Ticket01基线）

这是迁移账本，不是“目录存在即有效”的功能列表。范围为当前旧Web公开操作、独立Worker工作台与PRD替代行为。01C没有重跑所有历史操作；没有逐操作真实证据的行一律待核验，不静默删除。新页面不导入旧目录，未迁移操作通过明确“旧版”链接保留。

状态：**历史有效**=已有指定验收文档说明曾成功，本轮待复验；**待核验**=已找到UI/API操作但缺本轮真实证明；**被新规则替代**=仅替换明确冲突行为；**未实现**=新PRD目标，不宣称旧版支持。本票“已验证”分别见末尾01C受控组件证明与integration真实操作补录；两类证据不得互相替代。路径参数以`:p/:s/:t`表示Project/Session/Task。

权限代号（最终以服务端判定，不能用UI判断替代）：A本人账号；TA团队owner/admin；PV项目可见成员；PM项目管理者；SW会话获权写；SC会话获权控制；WV节点use；WM节点manage/实例管理员；L本机Web身份；C外部连接器/Channel受限能力。PM不自动取得私有Session内容。

| 用户操作 | 旧入口 / 源码接缝 | 现有有效性与证据 | 新版目标 / 负责票 | 权限 / 必验异常 |
| --- | --- | --- | --- | --- |
| 登录、Cookie恢复、退出 | `/` 内联 `components/landing.tsx`；`api/client.ts` | 历史有效：`account-identity-security-and-linking.md`；01A 295旧Web测试，不代替浏览器 | `/next/` 内联 + 壳退出，01 | A；401、过期、网络、退出失败不得假报成功 |
| 注册、重发验证邮件、验证 | `/`注册；`/auth/verify-email` | 历史有效：`account-identity-deployer-admin.md`，本轮待复验 | 账号，02；当前旧版可达 | 匿名；邀请策略、邮件503、过期/重复token |
| 找回密码、重置 | `/`找回；`/auth/password/reset` | 待核验：`auth-form.tsx`、`auth-link.tsx` | 账号，02 | 匿名；不泄漏账号、失效token |
| Google登录、绑定、解绑 | 登录页、`/settings` | 历史有效：`account-identity-security-and-linking.md`；01B回调合同测试 | 账号，02；当前旧版 | A；state/replay、返回位置、最后登录方式 |
| 修改密码、申请/确认邮箱变更 | `/settings`、`/auth/confirm-email-change` | 待核验：`components/account-page.tsx` | 设置/安全，02 | A；再认证、冲突、邮件不可用 |
| 登录会话列表、撤销单会话、全部退出 | `/settings` | 历史有效：账号安全验收文档；本轮待复验 | 设置/安全，02 | A；本人/其他会话隔离、CSRF、即时失效 |
| PAT创建、轮换、撤销 | `/settings`；`personalAccessTokens` API | 待核验 | 设置/安全，02 | A；一次性Secret、过期scope、撤权 |
| 账号注销确认、禁用、恢复、管理员删除 | `/settings`；`accountLifecycle/manageAccount` | 待核验 | 设置/账号管理，02 | A/实例管理员；自锁、二次确认、身份过期 |
| 注册策略查看/调整、审计查询/导出 | `/settings`；`registrationPolicy/audit` | 待核验 | 设置，02 | 实例管理员/A获权审计；越权、分页、导出敏感数据 |
| 团队创建、切换、成员查看 | `/teams`；`components/team-page.tsx` | 待核验 | 团队，02 | A/团队成员；切换清缓存、无团队 |
| 邀请、重发/撤销、查看/接受邀请 | `/teams`、`/join` | 待核验：`team-invitation.tsx`与客户端邀请API | 团队，02 | TA/受邀本人；过期、身份不符、重复接受 |
| 成员改角色、移除、转让所有权 | `/teams` | 待核验 | 团队，02 | TA；最后owner、降权、CAS/并发 |
| 项目列表、搜索、打开项目、刷新/深链接 | `/projects`、`/projects/:p` | 历史有效：`project-session-query-link.md`；01C受控与真实脚本分开 | `/next/projects`、概要，01；完整03 | PV；隐私过滤、空态、404/403分类、错误重试 |
| 创建项目、配置Repository | 旧创建对话、项目设置；`createProject` | 待核验：`create-dialog.tsx`、`project-resources.tsx` | 项目，03 | 项目创建授权/PM；重复、无效仓库、失败幂等 |
| 项目可见范围、授予/撤销成员角色 | 项目设置；`project-access.tsx` | 待核验 | 项目权限，02/03 | PM；私有权限、即时撤权 |
| Workspace列表、创建、选取 | 项目工作区；`createWorkspace` | 历史有效：`r2-real-pi-session.md`局部临时环境；本轮待复验 | 项目/工作区，03 | PV/写授权+WV；路径、仓库失败、离线 |
| 新增Placement、重建/重试工作区 | `/projects/:p/workspaces`；`addWorkspacePlacement/reprovisionWorkspace` | 待核验 | 工作区，03 | PM/WV；不同节点路径独立、重复重试 |
| Task创建、编辑标题/描述/状态/优先级 | 项目board/tasks；`features/tasks/project-pages.tsx` | 待核验：任务切片历史记录不作当前全部完成证明 | 项目/任务，03 | 项目写；CAS、空值、未保存导航提醒 |
| Task添加/移除Link、查看活动 | 任务详情；`addTaskLink/removeTaskLink/taskActivity` | 待核验 | 任务详情，03 | 项目写/PV；链接安全、并发、分页 |
| 指派/清除Agent；绑定/解绑Workspace | 任务详情；`assignTask/bindTaskWorkspace` | 待核验 | 任务，03/07 | 项目写+WV；不可用Agent、缺Placement、运行中变化 |
| Task内创建Workspace、失败重试 | 任务详情；`createTaskWorkspace/retryTaskWorkspace` | 待核验 | 任务，03 | 项目写+WV；requestId重试、异体冲突 |
| 创建会话/快速试聊无需Task | 创建对话、Agent试聊、项目Session入口 | **被新规则替代**：所有Session绑定Task，不能保留无Task绕行 | 自动专用Task，04；本地13 | SW/WV；旧API兼容转换、归属固定 |
| Task启动Run、复用Session、取消Run | Task详情；`launch/cancelRun` | 待核验 | 任务执行，07 | 项目执行权限；取消排队/启动/完成竞态 |
| 查看任务/项目活动、全局时间线 | 项目activity、`/timeline` | 待核验：`features/timeline`与`projectActivity` | 项目活动/待办，07/15 | PV；私有Session元数据隔离、新鲜度 |
| 查看会话列表、打开历史、深链接补选 | `/projects/:p/sessions`；`project-session-list.tsx` | 历史有效：`project-session-query-link.md` | 任务/会话，04 | 会话read；Task可见不等于内容可见 |
| 发送文本、图片/附件、消息排队 | 会话composer；`conversation.tsx`、`image-attachments.ts` | 历史有效局部Pi文本：`r2-real-pi-session.md`；附件/队列本轮待核验 | 会话，04 | SW；幂等未知响应重试、尺寸/类型、离线 |
| 停止Turn、取消排队消息 | Session控制；`stopTurn/cancelQueued` | 历史局部测试：`m2-workbench-final.md`；真实Runtime待复验 | 会话，04 | SC/SW；已完成/开始竞态，不删已接受消息 |
| 运行时命令、compact、计划/todo、建议输入 | 会话命令菜单；`slash-commands.ts/plan-card.tsx` | 待核验，命令列出不等于有效 | 会话，04/08 | SW与Runtime能力；unsupported显式拒绝 |
| 同一Session切换Model | Agent能力modelSwap及/model入口 | 新PRD快照规则**未验收**，不得假装旧行为等价 | 会话，04 | SW；下一Turn生效、排队快照、不换Session |
| 审批工具操作、拒绝、查看审批状态 | 会话审批及`/approvals` | 历史局部：`r-web-queue-approvals.md`；真实Runtime待复验 | 会话/待办，04/07 | 审批授权；过期、重放、无权 |
| 查看工具流、用量、Markdown、历史/断线恢复 | Session Surface/Journal | 历史有效局部：`r2-real-pi-session.md`；多Runtime未知 | 会话，04/08 | 会话read；缺口不显示synced、分页稳定、重复事件 |
| 会话改名、归档/恢复、删除 | 会话菜单；`patchSession/renameSession/deleteSession` | 待核验 | 会话，04 | SC；运行中拒绝、数据/文件生命周期区分 |
| 私有会话授权、共享范围、撤销 | `components/session-access.tsx` | 待核验 | 会话访问，09 | SC；元数据泄漏、撤权订阅 |
| 查看画布/血缘、切换单会话、拖动保存布局 | 项目canvas；`features/session-canvas` | 待核验 | 项目画布，09 | PV+每Sessionread；隐藏节点数量、CAS |
| 画布协作presence、焦点/typing | `canvas-collaboration.ts` | 待核验 | 画布，09 | 会话read；撤权/过期presence |
| Fork会话 | 会话/画布操作 | 待核验；跨Task历史复制被新规则禁止 | 同Task Fork，09 | 源/目标授权；跨Task拒绝无残留 |
| 浏览/读取/写入文件、Diff预览 | Session文件面板 | 待核验：`features/files`、客户端file API | 文件，10 | 会话read/write；路径逃逸、二进制/大文件、讨论写拒绝 |
| 创建终端、写入、调整尺寸、关闭 | Session终端面板 | 待核验：`features/terminal` | 终端，10 | 执行授权；断线清理、Shell绕行、只读讨论拒绝 |
| 成果登记、Run关联、成果审查 | Task成果区；`features/artifacts` | 待核验 | 任务成果，10/07 | 项目写/审查者；真实产物、CAS、拒绝修改 |
| 提交完成、审查批准/要求修改 | Task review；`features/tasks/review.tsx` | 旧手工review待核验；Run成功≠done保留；新多阶段/Agent审查**未实现** | 完成策略，07 | 配置管理/审查者；执行者不能移除审查 |
| 待办聚合、跳转审批/任务 | `/attention` | 历史修复：`attention-schema-repair.md`；本轮待复验 | 待办，07 | 可见资源；错误不可当空态 |
| Worker注册令牌、安装命令、tailnet诊断 | `/cluster`；`worker-enrollment-dialog.tsx` | 历史有效：`local-instance-consolidation.md`（上线部分）、`r2-linux-worker-installer.md`（边界有限） | 集群，11 | WM；令牌只显一次、HTTP复制、过期/错误宿主 |
| Worker健康/版本/撤销、能力查看 | `/cluster`；`cluster-page.tsx` | 历史有效局部：同上；当前版本待核验 | 集群，11 | WV/WM；撤销不是删除、离线数据新鲜度 |
| Worker共享范围、使用/管理授权 | `/cluster`；`worker-access.tsx` | 待核验 | 集群权限，11 | WM；撤权活跃Session、用途边界 |
| Agent/Model选择、查看认证不可用原因 | `/runtime`、`/runtimes`、创建对话 | 待核验；逐Runtime见独立盘点 | 集群/Runtime，11/08 | WV；候选≠ready、模型认证/成本未知 |
| Skill编辑、版本发布、绑定、启停、分发状态 | 项目skills/全局资源；`features/skills` | 历史局部：`docs/specs/r1-stage4-resource-acceptance.md`；本轮待复验 | 项目/资源，11 | 管理授权；版本CAS、完整性、未生效 |
| Preset编辑、显式应用、部署差异/失败重试 | `features/presets` | 历史有效局部：`r2-preset-manual-application.md` | 资源，11 | WM；显式确认、安装网络、凭据不下发 |
| Provider版本发布、绑定、候选Model选择 | `provider-publish.ts`、资源面板 | 历史局部：`r3-provider-version-publish.md`、`r3-provider-candidate-web.md` | 资源，11 | 管理授权；凭据locator、不把候选当验证模型 |
| Connector列表、创建/编辑、启停、连接测试 | 项目connectors；`connector-page.tsx` | 历史有效局部：`connector-module-g42.md`；外网未统一验收 | 项目/连接器，12 | PM+C；私网/协议风险、Secret、故障恢复 |
| Connector能力调用/审批/结果查看 | 会话工具+审批 | 待核验；旧外部写能力需05首次协调门一起限制 | 会话/连接器，05/12 | C+SW；读写分类、审批与调用身份 |
| Channel创建、测试、启停、令牌轮换/删除 | 项目channels；`channel-page.tsx` | 待核验：`apps/e2e/channel-browser.mjs`脚本不是本轮结果 | Channel，12 | PM+C；Secret、重复投递、失效凭据 |
| Channel绑定创建/启停、失败投递重放 | 项目channels；`createChannelBinding/replayChannelDelivery` | 待核验 | Channel，12 | PM+C；幂等/重放边界、外部副作用授权 |
| 全局命令/搜索、快捷导航、未保存提醒 | `features/command-palette`、`app/router.tsx` | 待核验旧版；01C已做项目搜索/命令/登录离开提醒子集 | 壳01及各编辑票，15全量收口 | 当前可见对象；键盘焦点、跨账号清理、编辑丢失 |
| 独立Worker登录/退出、目录授权 | `/local`；`hosts/local-session.ts` | 历史局部：`m2-worker-local-workbench.md`；共享Web真实包门见`r-web-session-slice.md` | 本机工作台，13 | L；不得调用集群身份、目录边界 |
| 本机建会话、发送/停止/队列取消/审批/历史 | `/local/sessions/:s` | 历史fixture：`r-web-session-slice.md`、`r-web-queue-approvals.md`，不视为真实包验收；无Task创建**被替代** | 本地Task/会话，13 | L；本地幂等、断线、Task固定 |
| 本机Agent路径选择/重置、托管安装/进度 | `/local/settings` | 历史局部：`r-web-local-settings-cluster.md`；联网安装待授权实测 | 本机设置，14 | L；失败重试、不覆盖全局、重启生效 |
| 本机Provider凭据新增/更新/删除、Connector凭据 | `/local/settings` | 历史局部：`r3-worker-local-provider-ui.md` | 本机设置，14 | L；Secret不返回、版本冲突、删除locator |
| 本机Connector保存/删除 | `/local/settings` | 待核验 | 本机设置，14 | L+C；外部写需授权 |
| 发现Server、加入/暂停/恢复/退出集群 | `/local/cluster` | 历史局部：`r-web-local-settings-cluster.md` | 本机集群，14 | L+注册令牌；不上传本地会话、重试不换身份 |
| Team协调聊天、懒创建/复用/重开上下文 | 无现成合格入口 | **未实现**，新PRD | 平台协调，05 | 受限执行，首次开放前Runtime安全门 |
| 项目级Agent发现/建Task/读关联Session | 现有capability接缝不等于新能力 | **未实现/待补齐**，新PRD | 项目API，05/08 | 可信身份交集、私有历史过滤、分页/新鲜度 |
| 版本计划批准、固定版本交接 | 现有计划卡不等于版本授权 | **未实现**，新PRD | 协调/任务计划，06 | revision绑定、幂等、越权/范围变更 |
| 数据重置、正式入口切换、旧版移除 | 无常规UI操作 | **未实施**；须独立清单/备份/停执行批准 | 运维，16 | 不删源码/外部仓库/全局认证，恢复演练 |

证据路径简写均相对于 `docs/acceptance/`，例外明确为源码或spec路径。源码盘点锚点：`apps/web/src/app/host-paths.ts`、`apps/web/src/api/client.ts`、`apps/web/src/hosts/local-session.ts`，以及表中组件。旧API实现并不自动保证按钮存在或运行有效；待核验行后续需记录实际入口、操作结果及异常证据，必要时澄清产品决策，不以删入口收口。

## 01C已做与未做

已实现新版壳、内联密码登录、身份失效清内容、真实合同项目列表/概要、失败重试、项目搜索/命令、移动导航、焦点/滚动、HTTP复制降级。01C受控浏览器仅证明这些交互与错误分支，测试数据不是真实项目。账号02、项目管理03及之后没有预建占位页面；壳链接显式标旧版。

01C交接时，真实账号/真实项目/旧新入口/桌面手机待integration在同实例发布后执行 `apps/web-next/tests/real-instance.mjs`；该脚本现已执行，范围与结果见下节，不覆盖未验操作。所有旧有效操作在15须逐项迁移复验；目前没有任何一行授权删除旧入口。

## Ticket01 integration 实际操作证据（2026-09-30）

同一现有实例完成 `apps/web-next/tests/real-instance.mjs`，原始证据 `/tmp/wemux-ticket01-integration/real-browser/result.json`：桌面1440×900和手机390×844均完成真实账号新版登录、获权项目概要/列表、深链接query返回、刷新、后退、退出后再刷新仍未登录；HTTP复制明确转选择文本。使用同一Cookie打开旧 `/projects`，等待实际项目名称出现而非HTTP200。新旧入口零非预期console/pageerror/requestfailed；匿名auth/me 401及已收到401/204后的身份取消有精确分类，不宣称浏览器完全没有错误级日志。

上述操作从待核验推进为“本轮真实已验证”，仅限实际脚本覆盖部分。旧根重新输入凭据登录、真实账号过期/单会话撤销、旧Session稳定加载、旧入口创建/发送**本轮未验**。同Cookie旧项目列表不等于旧会话或写路径通过，受控401不等于真实账号过期。旧会话/发送等条目仍保留待核验，不由本段一并升级。未调用收费模型；无清理数据或删除旧入口。

01C受控浏览器覆盖错误分类、空态/重试、手机焦点/导航、HTTP降级，证据仍仅为受控场景，不冒充当前账号的越权/真实过期测试。所有验收项映射及未完成门见 `.scratch/web-next-project-agent-platform/evidence/ticket-01-acceptance.md`；Ticket01保持in-progress，等待fresh独立审查及父会话决定。

## 独立审查后补验（Ticket01，2026-09-30）

新增可重复脚本 `apps/web-next/tests/real-legacy-regression.mjs`，只用stdin接收凭据，顶层固定错误边界。真实旧根独立browser context登录、既有历史文本与公开events freshness=synced、刷新/后退，以及本轮current登录会话经公开DELETE撤销后新旧页清空与保留目标，桌面/手机均完成断言。证据 `/tmp/wemux-ticket01-review-fixes/legacy-real/result.json`。最后一次有界诊断运行零非预期异常，但此前手机登录期间偶发ERR_ABORTED未捕获足够路径信息来确定根因，不能靠最后一次绿灯宣称竞态已经修复；旧浏览器稳定性门保留部分状态。

同实例安全写前置检查：既有账号可见项目的Workspace列表全部为空，无可选安全Test Agent落点，因此没有创建Task/Session/Run、没有发送消息，写门仍blocked。没有提供可用受限身份凭据，权限过滤仍blocked；未新建账号/Workspace或增权。历史只读结果不能替代上述门。早期失败尝试中有本轮测试登录未能精确清理，数量/ID未知；不得猜测或批量撤销，操作者可在账号设备会话页处理。脚本现记录自己current ID并finally仅撤销明确本轮会话，正常完成也验证目标被撤销。

独立review三finding已分别修复并提供红绿，待原reviewer复审：真实脚本全生命周期固定失败边界；手机summary逐项键盘可达；标准测试入口显式fresh构建前置。当前有效release为`20260930-ticket01-review-fixes`，此前dual-icons仍为保留回滚点，不再是当前release。本票仍in-progress。

### 测试诊断收尾状态

最新独立复审确认原三直接缺陷CLOSED；后续取消分类、显式浏览器设施、构建去重及提前登记本轮登录清理已在测试/脚本内修复，待复核。默认测试与必须显式执行的浏览器安全门分开，见`apps/web-next/tests/ACCEPTANCE.md`。本轮不部署、不真实登录，仍运行review-fixes release。已补旧登录/历史/公开撤销证据不回退为未验证，但自然TTL、无请求即时清屏不在证明范围。安全写、受限身份、早期偶发取消/遗留登录仍open，禁止用诊断单测代替真实验收。

## Ticket02 临时迁移补录

账号与团队管理已迁至 `/next/settings`、`/next/teams`、`/next/join`，公开注册/找回在新版登录页，邮件保留旧入口并提供同 token 新入口。逐项范围、35+94 定向测试与 67 项桌面/手机浏览器证据见 [Ticket02 账号与团队](web-next-account-team-membership.md)。旧入口没有删除。

该记录只升级文档中实际列明的已验操作，不把全部账号管理行升级为浏览器通过：外部 Google、删除/审计分页导出等仍有明确残余。`logout-all` 保留当前设备，当前契约在新版标作“退出其他设备”。项目资源权限完整迁移继续由 Ticket03 负责。Ticket01 依赖与 candidate/root gate 待完成，Ticket02 待独立 review。


## Ticket03 局部迁移补录（2026-10-01）

项目/Workspace/普通 Task 新版管理路径、公开 API 和桌面/手机浏览器的逐操作范围见 [Ticket03 局部证据](web-next-project-workspace-task-management.md)。本轮29项Server、39项client/application、42项项目浏览器检查通过，并再跑Ticket02双端115项检查。只升级该证据实际列明的操作，不将任务内一步创建Workspace、Task删除、Workspace删除、实际Worker文件准备或持久手工排序伪装完成。

修正端点盘点：legacy client 的 addWorkspacePlacement 方法不代表 dedicated placements endpoint存在；已有 `/workspaces/:id/reprovision` 支持 absent placement，新版通过此真实合同新增落点。Workspace DELETE固定501；Task DELETE没有合同；当前准备command取消受保护返回409。协议Worker的ready报告不等于真实clone/文件准备。Ticket03保持partial/in-progress，Ticket01依赖/candidate gate按用户允许延期，独立review待完成。

## Ticket03 准备取消的有效行为边界（2026-10-02）

| 操作 | 原有效语义 | 新版与验证 |
| --- | --- | --- |
| 未提交创建表单“取消” | 仅关闭表单，忙碌时禁用；不是Worker停止 | 不把导航/关闭表单解释为停止已提交准备 |
| DELETE `/commands/:id` 对workspace.provision | 当前准备保护拒绝；旧状态判断在报告先于receipt/旧attempt时存在误返回cancelled漏洞 | 所有provision身份均409 protected_command，无command/outbox/placement/files变化；精确路由补实际admin校验；Next改为不可用说明，不提供必然失败的正常取消按钮 |
| 成功停止已提交准备 | 未找到可迁移的有效协议/实现 | **未来产品缺口，未实现/未验证**；需要显式attempt取消、Worker settled证明及race策略，不能由ACK/timeout/pending冒充 |

详细红绿、真实Worker拒绝后继续完成证据与相邻admin授权源代码发现见Ticket03验收文档最后一节。此有限迁移行为本地通过不关闭复合验收或整个Ticket03。Workspace-delete remediation已独立复审no issues/OK with notes；本次准备保护/精确路由权限修复待review。


## Ticket03 普通Task高级Metadata JSON迁移（2026-10-03）

补录既有普通Task表单操作：legacy `features/tasks/board.tsx`高级设置与`TaskDraft`的Metadata JSON创建/编辑，迁到Next `TaskCreateForm`/`TaskContentEditor`。仅沿用schemaVersion1、values对象及Server内容CAS合同，没有新增metadata系统或key；无效JSON/schema保留原文显示实际原因、不写入。结构比较忽略key顺序/格式，同字段冲突必须选择，dirty-only/version PATCH、默认空values、权限和身份退休不变。

E10本地verified、待独立review：真实私有Server desktop/mobile18组，创建草稿五字段扩展12组、Project96；Server10与focused57通过。精确证据/失败记录/范围见[Ticket03 CURRENT与文末](web-next-project-workspace-task-management.md)。E9创建草稿fallback已review no issues / OK with notes，reviewer未重跑/hash/pixel-check。该有限操作迁移不关闭Ticket03/all16、历史删除/视觉/candidate/双宿主门，不授权移除旧版。
