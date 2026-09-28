# Paperclip 调研(paperclipai/paperclip)

日期:2026-09-28。方法:GitHub API 元数据核实 + 全量源码下载(`~/workspace/project/paperclip-upstream/paperclip`,tarball 38MB/解压 138MB,超出 30MB 预算但已 gzip 校验完整)+ 源码结构审读 + 官方文档站/README/AGENTS.md。

## 一、它是什么

**一句话**:自托管的多 Agent 编排控制平面,把一组 AI Agent 当作"公司"来运营——org chart(CEO/CTO/工程师,人和 agent 混编)、目标对齐(公司→团队→agent→任务)、预算(Token 薪水,超支自动暂停)、治理(审批门/暂停/解雇)。口号:"If OpenClaw is an employee, Paperclip is the company"。

**元数据(GitHub API 2026-09-28 核实)**:
- paperclipai/paperclip,MIT,TypeScript(97%),**89,967 stars** / 15,672 forks(2026-03-02 创建,7 个月)
- 当日仍有 push;5,862 open issues(增速过快的代价);最新 release v2026.916.0
- 仓库 290MB(GitHub size),tarball 38MB

**技术栈**:Node.js(Express)+ React/Vite/TanStack Query UI + PostgreSQL(开发态嵌 PGlite 零配置)+ Drizzle ORM + pnpm workspace(13 个 packages)。与我们 wemux-mini 同属 Node/TS/React/Vite/TanStack 家族,但栈重得多(Express+Drizzle+PG,我们是 node:http+node:sqlite)。

**与我们的定位差异(关键)**:
| 维度 | Paperclip | wemux-mini |
|---|---|---|
| 核心隐喻 | AI 公司(org chart/预算/治理) | Agent 集群管理(Server/Worker/Session) |
| 执行位置 | Server 中央编排,heartbeat 唤醒 agent | Worker 分布执行,Server 只做控制面 |
| Agent 对接 | "能收到 heartbeat 就能被雇":Claude Code/Codex/Cursor/OpenClaw/bash/HTTP bot | Pi/Claude CLI 本机 RPC,Worker 就地执行 |
| 数据库 | Postgres(含嵌入式 PGlite) | node:sqlite |
| 多租户 | 多"公司"隔离 | Team→Project |

## 二、架构亮点(源码实证)

- **Heartbeat 执行引擎**(`server/src/services/heartbeat.ts`,2.9 万行单文件):DB 唤醒队列+合并(coalescing)、原子任务签出(防双跑)、孤儿 run 自动恢复、结构化 run 事件(`heartbeat_run_events` 表,本地留存的三条数据路径之一)。
- **Adapter 插件体系**(`packages/adapters/claude-local|codex-local|cursor-cloud...`,每个 adapter 有 cli/server/ui 三段):统一"雇佣"异构 agent;另有 adapter-plugin.md 定义进程外插件协议。
- **Apps/连接器目录**(`doc/connections/`,35 份文档):这正是他们版的"连接器模块"。核心思路:**"目录条目是便利层,不是前置条件"**——任何符合标准的 remote HTTP MCP server 都能经通用路径接入零代码;目录条目只是为值得推广的 vendor 提供品牌/定制字段/校验/支持文案。CONNECTOR-PLAYBOOK.md 是"agent 可执行的连接器研发手册"(供应商调研→实现→测试→live proof→PR 全流程)。
- **凭证治理**:实例 vault 存资源凭证;"sign-in 认证人 ≠ resource connection 授权外部操作"的身份边界;MCP 访问治理(MCP-ACCESS-GOVERNANCE.md);可选 Vercel Connect(凭证留在运营者 Vercel 账户,调用时解析短时 token——与我们的 BYOK 精神同源)。
- **部署模式**(`doc/DEPLOYMENT-MODES.md`):`local_trusted`(免登录)vs `authenticated`(private/public),bind(loopback/lan/tailnet/custom)与 auth 分离——与我们的双宿主+Tailscale 思路高度相似,他们同样把 tailnet 当一等公民。
- **四通道发布**:stable/beta/nightly/canary,nightly 必须过真实 Docker+浏览器冒烟才发——发布纪律值得学。
- **三条数据路径命名**(AGENTS.md 第 5 条):Telemetry(回传 Paperclip,默认开、严格评审)/Observability(OTEL,运营者设置端点才启用)/Run log(本地库),按路径而非词义区分评审等级——数据边界管理的好范式。

## 三、对我们有用的借鉴点

1. **"通用路径先行,目录是便利层"的连接器哲学**(CONNECTOR-PLAYBOOK):我们的 G44 通用 HTTP 连接器+G43 MCP 客户端恰好就是这个"通用路径",Paperclip 验证了不必为每个 vendor 写连接器、MCP 就是长尾答案。未来若要加"预置连接器目录",照抄他们"目录条目只加便利不加能力"的边界,避免目录变成第二套连接机制。
2. **Agent 可执行的研发手册**:CONNECTOR-PLAYBOOK 让外部贡献者/agent 按 runbook 交付连接器(含 live proof 证据要求),我们的 pi 派发单文化可以升级成仓内 runbook。
3. **heartbeat 队列语义**(coalescing/原子签出/孤儿恢复):wemux 若做"定时唤醒 agent"类功能(M8 受控自动化/Routines),这是现成的语义参考;我们已有的 taskId 幂等+CAS 与其同构。
4. **Telemetry 三路径分级**:自托管产品的数据回传默认开+可关+按路径分级评审,比一刀切"全部 opt-in"或"全部回传"都细腻。
5. **四通道发布纪律**:nightly 过真实冒烟才发,可直接搬进我们的发布流程。

## 四、风险与判断

- 7 个月 9 万 star 的增速伴随 5.8k open issues,API/契约仍在剧烈变动,不宜深度依赖其代码;且 MIT 无许可障碍,可自由借鉴。
- 体量(138MB/13 packages/2.9 万行单文件服务)与我们的轻量约束相反,整体引入不可行,只值得借模式与文档范式。
- 它是"中央编排"派(agent 被 server 唤醒),我们是"分布执行"派(worker 就地跑 agent),架构哲学不同,借鉴时注意语义平移而非代码平移。

## 附:本地留存

- 源码:`~/workspace/project/paperclip-upstream/paperclip/`(master 分支)
- 关键索引:`server/src/services/heartbeat.ts`(29762 行)、`server/src/adapters/`、`packages/adapters/{claude,codex,cursor}-*`、`doc/connections/CONNECTOR-PLAYBOOK.md`、`doc/DEPLOYMENT-MODES.md`、`doc/CHANNELS.md`、`AGENTS.md`(工程规则)
