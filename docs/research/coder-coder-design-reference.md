# coder/coder 调研：wemux-mini 可借鉴的设计

调研对象：github.com/coder/coder（14.3K stars，Go 单二进制，Apache-2.0）。定位是自托管云端开发环境（Workspace）+ AI Agent 基础设施。调研时间 2026-09，基于 coder.com/docs 与 GitHub main 分支文档源码（本地备份在 `tmp/coder-docs/`）。

与 wemux-mini 的关键差异前提：Coder 的 workspace 是**云资源**（由 Terraform 创建销毁），agent loop 在**控制面**跑；wemux-mini 的 workspace 是逻辑环境 + Worker 物理落点，agent 在 **Worker 本地**跑 + BYOK。所以 Coder 的"控制面集中治理"模式不能整体照搬，但很多机制层面的设计值得抄。

分级说明：
- **可直接抄**：机制与 mini 约束（node:http+sqlite、无 K8s、Worker 独立安装）兼容，落地成本低。
- **需改造**：思路对但 Coder 的实现绑定了 Postgres/Terraform/Go 生态，要按 mini 的形态重设计。
- **不适用**：依赖 Terraform/K8s/多租户企业特性，或与 mini 的 BYOK 本地执行架构根本冲突。

---

## 1. Workspace/环境管理（对应 M3：Workspace Placement 多节点环境）

### 可直接抄

**1.1 五态生命周期状态机**：`Running / Stopped / Deleted` 三常态 + `Failed / Unhealthy` 两破损态，且明确区分失败原因：Failed=供给失败（无资源消耗），Unhealthy=资源已供给但 agent 连不上。Placement `(workspaceId, workerId)` 可以直接套用这个状态语义：placement 建立即 Running、Worker 下线即 Unhealthy（而非 Offline 混称）、供给失败（路径创建失败/agent 探测失败）即 Failed。
出处：https://coder.com/docs/user-guides/workspace-lifecycle

**1.2 活动检测驱动 autostop + activity bump**：autostop 到期不会硬停，而是等用户真正不活跃后再宽限检查（默认 1h bump）；活动判定有明确白名单——SSH/终端/IDE 会话算活动，"看 dashboard/看日志/后台统计上报"不算。mini 的 Worker/Placement 空闲回收可直接抄这套判定语义（WS 连接活跃 + agent 会话中有进行中 turn 算活动，纯 Web 浏览不算）。Coder 还专门把"AI agent 任务状态为 working"列为活动信号以延长 deadline——mini 的 Task in_progress 应该阻止 worker 自动休眠，这是现成结论。
出处：https://coder.com/docs/user-guides/workspace-scheduling

**1.3 AI agent 状态保活 + 手动 extend API**：workspace agent 可调 `PUT /api/v2/workspaces/{id}/extend` 主动上报"我在跑长任务，别停我"（文档给了训练脚本循环上报的例子）。mini 的 worker 可加同样端点：Agent 执行长任务时代理自动续约，避免被空闲策略误杀。
出处：https://coder.com/docs/reference（"Manually send workspace activity"节）

**1.4 启动分阶段计时（build timings）**：dashboard 展示启动过程的分阶段耗时（供给、agent 启动、各 startup script）。mini 的 worker 启动/placement 建立也可以分阶段打点上报，Web 端做"为什么这个环境还没就绪"的可视化，排障价值高。
出处：https://coder.com/docs/user-guides/workspace-lifecycle（Workspace build times 节）

### 需改造

**1.5 参数化创建表单（parameters + presets）**：`coder_parameter` 类型系统（string/bool/number/list + min/max/regex/monotonic 校验 + options 枚举 + mutable/ephemeral 标志），以及 `coder_workspace_preset`（常用参数组合存成预设，一键选择）。mini 的 M3"项目环境"如果做成"环境模板"（预选 agent、模型、启动命令、worktree 路径的组合），preset 是现成交互范式。ephemeral 参数（只影响下一次启动，如"跳过缓存重建"）也适合 mini 的 placement 重建场景。但 Terraform DSL 不抄，用 JSON Schema 表达即可。
出处：https://coder.com/docs/admin/templates/extending-templates/parameters

**1.6 模板版本化 + 兼容性提示**：模板是带版本的 immutable 产物（template version），workspace 绑定版本；模板参数变更导致旧值失效时，更新 workspace 会弹窗强制用户选新值，防止"卡死在过期模板版本"。mini 的环境模板/agent 配置版本化可借鉴：模板升级后旧 placement 更新时引导重新确认参数。
出处：https://coder.com/docs/admin/templates/extending-templates/parameters（Parameter Options 不兼容节）

### 不适用

**1.7 Terraform 供给管线 + ephemeral/persistent 资源语义**：整套 build = terraform apply/destroy、资源分 ephemeral（stop 即销毁重建）与 persistent（stop 保留）、失败可 orphan 资源。mini 的 Worker 是用户自有机器、无 IaC 供给，placement 只是目录 + 注册记录，不存在"销毁云资源"语义。
出处：https://coder.com/docs/admin/infrastructure/architecture

**1.8 企业调度特性**：autostop requirement（强制停机窗）、quiet hours、dormancy 自动删除、failure TTL、quotas。这些面向多租户成本治理，mini 单团队自托管用不上（dormancy 思路上文 1.2 已吸收其轻量版）。
出处：https://coder.com/docs/user-guides/workspace-scheduling

---

## 2. Agent 治理（对应 M4：Worker/Agent 管理）

### 可直接抄

**2.1 "Agent 状态存数据库而非执行环境"**：Coder Agents 的 chat 全量状态（消息、token 用量、压缩上下文、排队消息）存控制面 Postgres，"workspace 停止/删除/重建，会话历史照样存活，agent 可换一个 workspace 续跑"。mini 已经把 Session lineage 放 server，方向一致，值得抄的是细节：压缩上下文带 compression 标志保留原文、用户在 agent 工作中发的消息进队列按序投递、parent/child 关系支持 sub-agent。这直接支撑 mini 的 Agent Network P1（多 Agent）。
出处：https://coder.com/docs/ai-coder/agents/architecture（Chat state and persistence 节）

**2.2 Sub-agent 编排工具面**：`spawn_agent(type=general|explore)` / `wait_agent` / `message_agent` / `close_agent` / `list_agents`，且**平台级工具（建 workspace、spawn）只对 root chat 开放，sub-agent 无权再 spawn 或建环境**——防止递归爆炸与提权。mini 的 Agent Network 设计多 Agent 协作时应抄这个"编排权只在一层"的规则。
出处：https://coder.com/docs/ai-coder/agents（Sub-agents 节 + Built-in tools 表）

**2.3 Plan mode 工具降级**：计划模式下 `write_file/edit_files` 被限制为只能写 plan 文件，`execute` 保留用于探索（clone 仓库、跑只读命令），并配 `propose_plan`（出 Markdown 计划给用户审）+ `ask_user_question`（结构化追问）。这与 mini"Run 成功不得自动 done、需人工审查"的门禁哲学同源，且给出了可操作的工具级实现：按模式收缩工具面，而不是只靠提示词。模式状态存在 chat 上，刷新页面不丢。
出处：https://coder.com/docs/ai-coder/agents/architecture（Tool execution / Plan mode 节）

**2.4 指令链路复用 + 懒连接**：agent 的工具调用走与 web 终端/IDE 完全相同的隧道（Tailnet/DERP），不新开网络路径、不开新端口；到 workspace 的连接是懒建立（首个需要 workspace 的工具调用才连），纯问答类 chat 永远不建 workspace 连接。mini 的 server→worker 指令应继续走既有 WS 可靠传输通道，不要为 agent 工具另开通道；懒连接对"计划/纯对话 session 不落 worker"有直接参考价值。
出处：https://coder.com/docs/ai-coder/agents/architecture（The same connection your IDE uses 节）

### 需改造

**2.5 AI Gateway 的"集中 BYOK + 审计"形态**：网关拦截所有 agent↔LLM 流量，用户用平台身份认证（不再各自管 provider key），逐条记录 prompt/token/工具调用用于成本归因与审计；还支持 MCP 服务器集中注入。mini 是 BYOK（key 在 worker 本地），不需要照搬网关，但"token 用量按 user/session 归因记录"这一层值得抄：worker 执行 turn 时上报 token 用量回 server，server 端做 per-session 成本账。如果未来 mini 要出"团队共享 key"特性，AI Gateway 的模式（coderd 持有 key、workspace 只见会话）是标准答案。
出处：https://coder.com/docs/ai-coder/ai-gateway

**2.6 Agent Firewall（进程级出网管控）**：nsjail/Landlock 包裹 agent 进程，allowlist 规则（domain/method/path 粒度，支持 `domain=*.github.com`、`method=GET,HEAD domain=api.github.com` 语法），审计日志（decision=allow/deny + workspace/owner/method/url/matched_rule）流回控制面集中查看。这是 worker 本地治理的完整参考实现（开源 https://github.com/coder/boundary）：mini 的 Worker 可选配"agent 进程出网 allowlist + 拦截日志上报"，M4 治理能力的核心素材。注意它的教训表（nsjail 需 CAP_NET_ADMIN、Landlock 需内核 6.7+ 且可被代理端口绕过）。
出处：https://coder.com/docs/ai-coder/agent-firewall

**2.7 External Auth 的 GIT_ASKPASS 注入**：控制面存 OAuth token，workspace 内通过 `GIT_ASKPASS` 钩子按 git host 动态取 token（token 不落盘、进程按需经 CLI 换取：`coder external-auth access-token <id>`），且按模板声明的 provider 域名匹配。mini 若做"server 代管 git 凭据、worker 按需取"，这是标准模式：凭据集中存、运行时按 host 解析、不写入 workspace 磁盘。
出处：https://coder.com/docs/admin/external-auth（Git Authentication in Workspaces 节）

### 不适用

**2.8 Agent loop 在控制面跑**：Coder 的核心安全卖点（"No API keys in workspaces"、workspace 可完全网络隔离、集中式 system prompt/模型治理）。与 mini 的"worker 本地执行 + BYOK"根本架构相反，不照搬。但注意 Coder 自己也承认控制面模式的代价——控制面需要能出网到 LLM provider、要扛流式代理负载；mini 的 BYOK 反而免去这两点，属于合理取舍而非落后。
出处：https://coder.com/docs/ai-coder/agents（Security benefits 节）

---

## 3. 执行隔离（对比 mini 的 worker 本地执行 + BYOK）

### 需改造

**3.1 "What runs where" 职责表**：Coder 用一张表明确切分：agent loop/chat 状态/git 认证/用户身份/模型配置=控制面；文件读写/shell 执行/git 提交/构建测试=workspace。mini 应该有对应的显式切分表（会话状态/任务状态机/lineage=server；agent 进程管理/文件系统/exec=worker），写进 CONTEXT.md 级别的文档，避免后续功能漂移。
出处：https://coder.com/docs/ai-coder/agents/architecture（What runs where 节）

**3.2 身份随行（identity on every action）**：agent 的每个动作归因到提交 prompt 的用户，无共享 bot 账号；agent 权限=用户权限，无提权路径；跨用户 workspace 严格不可见。mini 的 Task/Run 审计（谁指派、谁批准 done）应抄这个原则：Run 记录发起者身份并贯穿到 worker 执行日志归因。
出处：https://coder.com/docs/ai-coder/agents/architecture（User identity on every action 节）

**3.3 Workspace agent 的注册鉴权方式**：workspace agent 首次认证支持云厂商 instance identity（AWS/Azure/GCP 签名文档换 token），替代静态 key。mini 的 worker 配对当前是 register token；若未来支持"worker 所在机器的可信证明"（如 Tailscale identity、主机指纹），可参考这套"一次性身份凭证换长期 token"模式。当前阶段 register token + 可 revoke 已够。
出处：https://coder.com/docs/reference/api/agents

### 不适用

**3.4 Postgres + provisioner 集群化**：coderd 是"唯一写 Postgres 的服务"、外置 provisioner 分载 build、scoped key/tag 路由。mini 单 sqlite + 单 server 场景不存在这套扩展问题。
出处：https://coder.com/docs/admin/infrastructure/architecture 、https://coder.com/docs/install/operate/provisioners（源码 docs/install/operate/provisioners/index.md）

---

## 4. 运维能力（对应 M7）

### 可直接抄

**4.1 数据保留策略（data retention）**：按类别配置保留期自动清理（audit log 0=永久、API keys 7d、agent logs 7d、AI Gateway 记录 60d），CLI flag/env/YAML 三种配置途径。mini 的 sqlite 会随会话/日志无限膨胀，这套"分类保留期 + 启动时清理"是 M7 的低成本必备项。
出处：https://coder.com/docs/admin/setup/data-retention（源码 docs/admin/setup/data-retention.md）

**4.2 升级前快照 + 不支持回滚的显式警告**：升级文档第一句就是 CAUTION"先做数据库快照，Coder 不支持回滚"，升级方式=重装覆盖二进制 + 重启。mini 的 M7 升级方案应对 sqlite 做同样约定：升级前自动 backup 数据库文件，文档明示无回滚。
出处：https://coder.com/docs/install/operate/upgrade（源码 docs/install/operate/upgrade.md）

**4.3 安装脚本统一入口**：`curl -fsSL https://coder.com/install.sh | sh` 一个脚本覆盖 Linux/macOS 二进制安装与升级复用。mini 的 worker 已有 tgz 分发，可补齐同款 `install.sh`（检测平台、装到用户目录、支持 systemd 模板），M7 发布物的范本。
出处：https://github.com/coder/coder（README Quickstart）

### 需改造

**4.4 Prometheus /metrics 端点**：控制面暴露 Prometheus 指标（需显式开启）。mini 不必上 Prometheus 栈，但"server 暴露 `/metrics` 文本端点 + worker 心跳携带资源指标"的分层值得保留：先做 JSON 指标端点供 Web 展示，格式对齐 Prometheus 文本协议以便未来接入。
出处：https://coder.com/docs/admin/monitoring/metrics

**4.5 Agent metadata 的写负载控制**：agent 定期跑脚本采集 CPU/内存/磁盘并上报，文档给出写入负载公式（条数×agent 数×2/平均间隔）并警告会打爆数据库、建议用 UNLOGGED 表 + NOTIFY 流式推送。mini 的 worker 指标上报直接吸取教训：低频（≥30s）、写 sqlite 临时表或只走 WS 推送不落库、UI 实时数据与历史数据分离。
出处：https://coder.com/docs/admin/templates/extending-templates/agent-metadata（Managing the database load 节）

### 不适用

**4.6 Helm/K8s 升级路径、HA 多副本**：docker-compose pull / helm upgrade / AMI 等运维故事都基于容器编排生态。mini 的部署单元是"node 进程 + sqlite 文件"，M7 用 systemd/安装脚本 + 数据目录约定即可。
出处：https://coder.com/docs/install/operate/upgrade

---

## 5. UI/交互（对应 mini 的 web）

### 可直接抄

**5.1 Workspace 列表的结构化过滤语法**：列表 API 用 `key:value` 查询语法（owner/template/status/has-agent/dormant/last_used_after/has-ai-task/healthy...），URL 即查询状态。mini 的 worker/session 列表可抄这个约定：过滤器编码进 URL query，API 与 Web 共用同一语法，列表可分享/收藏。
出处：https://coder.com/docs/reference/api/workspaces（List workspaces 的 q 参数）

**5.2 状态可解释的 workspace 视图**：dashboard 的 workspace 详情展示 agent 健康、启动分阶段计时、startup script 逐条日志（coder_script 的 display_name/icon/start_blocks_login）。mini 的 placement 详情页应对应：worker 连接状态 + agent 就绪度 + 安装/启动日志流，"Unhealthy 时告诉你卡在哪一步"。
出处：https://coder.com/docs/user-guides/workspace-lifecycle（build times 节）、https://coder.com/docs/admin/templates/extending-templates（coder_script 节）

**5.3 创建表单的 preset 下拉 + URL autofill**：`param.<name>=<value>` URL 参数预填创建表单（平台团队可发预填链接）；最近用过的参数自动回填。mini 的"新建环境/新建 session"表单可抄：URL 预填 + 记住用户上次选择。
出处：https://coder.com/docs/admin/templates/extending-templates/parameters（Create Autofill 节）

**5.4 Schedule 设置页的层级**：workspace 设置里独立的 Schedule 页签（autostop TTL 可视化、activity bump 说明文案直接显示在 autostop 描述里）。mini 的 worker/placement 空闲策略设置可抄这个信息设计：把"宽限期多久、什么算活动"直接写在设置项描述里，不藏在文档。
出处：https://coder.com/docs/user-guides/workspace-scheduling（Where to find the schedule settings 节）

### 需改造

**5.5 模板管理 = 版本化产物的 UI**：模板列表 + 版本历史 + 在 dashboard 直接编辑模板文件 + pull/push CLI 往返。mini 的"环境模板"若是 JSON 存 server，可做同款版本列表 + diff 视图，但在线编辑器非必需（GitOps 式导出/导入更合 mini 体量）。
出处：https://coder.com/docs/admin/templates/managing-templates

---

## 6. 不适用部分汇总（因 mini 轻量级：无 Terraform/无 K8s/单 sqlite）

| Coder 设计 | 不适用原因 |
|---|---|
| Terraform 模板与 provisionerd 供给管线 | mini 无 IaC 供给，Worker 是用户自有机器 |
| ephemeral/persistent 资源 + terraform destroy 删除语义 | 无云资源可销毁；placement 只有目录与注册记录 |
| Postgres 单写者 + 外置 provisioner 扩展架构 | mini 单 sqlite 单进程，无扩展需求 |
| Agent loop 在控制面 + workspace 零 AI 感知 | 与 mini 的 worker 本地执行 + BYOK 根本相反 |
| 企业多租户：quotas/quiet hours/dormancy/RBAC 组 | 单团队自托管场景过度设计 |
| Helm/K8s/AMI 部署与升级故事 | mini 部署单元是 node 进程 + sqlite 文件 |
| Premium 功能（AI Gateway/Agent Firewall/AI 审计） | 闭源付费；但其设计文档是公开的可借鉴素材（见 2.5/2.6） |
| Agent Relay / Coder Tasks（ESR 淘汰中） | Coder Tasks 2026-09 起进入 12 个月 ESR，被 Coder Agents 取代，不建议参照其形态；其 AgentAPI（状态上报桥）思路已被 mini 的 Task 状态机覆盖 |
出处：https://coder.com/docs/ai-coder/tasks（顶部 WARNING）

---

## 落地优先级建议（结合 mini roadmap）

1. **M3 前**：placement 五态状态机（1.1）+ 活动检测语义（1.2）+ agent 状态保活端点（1.3）——Worker/Placement 生命周期的基础语义，低成本高回报。
2. **M4 时**：Agent Network 的"编排权单层"规则（2.2）+ Plan-mode 工具降级（2.3）+ token 用量归因上报（2.5 轻量版）+ What-runs-where 职责表写入 docs（3.1）。
3. **M7 时**：data retention 分类清理（4.1）+ 升级前 sqlite 快照约定（4.2）+ install.sh（4.3）+ 低频指标上报（4.5）。
4. **Web 持续**：URL 化过滤器（5.1）+ 状态可解释详情页（5.2）+ 表单 autofill（5.3）。
