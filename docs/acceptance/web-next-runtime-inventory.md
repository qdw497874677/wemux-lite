# Ticket 01 Runtime 能力基线盘点

本表区分实现声明、历史执行证据、当前实例待核验。01C 未访问全局认证文件、未启动 Runtime、未运行模型或外部写入；不以 Adapter 存在判定支持。未知不表示废弃，交04/05/08/11/13验证。

| Runtime | 版本证据与当前版本 | 认证条件与可靠性 | 已有证据限定 | 模型切换 | 平台工具 | 讨论限制 / 后续门槛 |
| --- | --- | --- | --- | --- | --- | --- |
| Pi | `apps/worker/src/runtimes/management.ts` 固定托管包0.85.1；`agents/pi-agent.ts` 拒绝低于0.85.1。2026-09-30同实例获权API报告在线Pi 0.87.1、本机可执行路径；不是托管包0.85.1，实际探针时间未单独返回。 | RPC `get_available_models` 非空才能上报 available；模型列出仍不保证付费资格和网络可达。01C 未重新认证。 | `docs/acceptance/r2-real-pi-session.md` 记录2026-09-29真实认证模型两轮与Worker重启恢复成功；是历史临时夹具，不是本轮同实例验收。`r3-real-pi-offline-https.md` 为真实Pi对假模型，不能证明公网认证。 | 源码声明 modelSwap=true，使用set_model；尚无本轮“同一Session/下一Turn/排队快照/CAS”实测，04验收。 | `agents/pi-agent.ts` 注入 capability extension、检查ready；`capabilities/pi-tools.js` 对应现有工具，不证明新PRD项目级API已实现。05验证受权查询/交接。 | 现有审批/扩展ready不等于禁止全部写副作用。首次协调开放前05须证明文件写、Shell、终端、连接器外部写等全部入口拒绝；目前未验收协调资格。 |
| Claude Code | 托管固定版本2.1.34；`agents/claude-agent.ts` 运行--version。同实例API版本为null、unavailable，不能视作已安装成功。 | `probeAuthorization` 非交互认证；源码把unknown也映射为available并附diagnostic，因此单看available不能声称可执行。实际认证与模型可用待08验证。 | 存在流式JSON/恢复/取消实现，未找到与当前版本及当前宿主绑定的真实付费执行报告；记录待核验，不把假CLI或单测当有效Runtime。 | `modelSwap=false`；不能把命令列表中的/model当作支持同Session切换，04明确拒绝。 | `--mcp-config` 注入Wemux MCP进程是实现接缝；新项目级API权限、取消、有效期与实际工具调用未知。 | `startTurn` 默认permission-mode为bypassPermissions（可被环境覆盖），无本轮受限讨论证明。05不得把该默认执行配置直接用于协调。普通授权实施不因此被删除。 |
| OpenCode | 无固定最低版本门；`agents/opencode-agent.ts` --version。托管固定版本1.18.31；同实例API在线版本1.18.10，不能混为托管版本。 | `models`目录非空就available；auth list凭据数为0可为unknown，因为可能有公共模型。目录不证明认证或请求成功。 | `application/runtime-adapters.ts` 注册实际Adapter仅为实现证据；当前真实执行、恢复、取消与用量未验收。 | 未声明modelSwap；04需实际协议确认，不可静默换Session或降级。 | Adapter/能力文件需05/08逐项验证实际工具暴露和可信调用身份；当前无新PRD工具实测。 | 任意Shell/文件/外部写阻断未证实，05首次开放前安全门。不能靠提示词称合格。 |
| Test Agent | 仓库受控测试实现，无生产版本或认证 | 无真实模型认证 | 仅测试夹具，不能算现有有效生产Runtime | 仅竞态测试替身 | 仅合同测试替身 | 不可替代05/08真实执行与安全证明 |
| Codex及其他未接入Runtime | 本轮范围外 | 未核验 | 不因架构可扩展而新增实现门槛 | 未实现/未知 | 未实现/未知 | 另票，非本轮有效Runtime声明 |

托管版本取值核验：`apps/worker/src/runtimes/management.ts` 的 `installCatalog`为安装白名单，不能证明在线Worker已经选用。integration已补获权API快照（见下节）；剩余未知由11核验：Worker标识、执行文件来源、探测时间、Agent version、authorization、availability、模型清单来源；报告只保留脱敏投影，不存密钥或全局认证文件。

## 必须补充的逐Runtime执行记录

1. 当前版本与认证成功条件、无认证/无模型/网络失败的明确不可用展示（11）。
2. 同Session两轮、取消、消息排队、重启恢复、当前Turn与下一Turn模型快照（04/08，Worker本地13）。
3. Web与Agent查询同项目同Task，私有Session隐藏、分页与新鲜度，幂等/CAS和撤权（05/08）。
4. 第一次协调资格判定：允许读取/计划/获批交接，实际拒绝代码写、任意Shell、依赖安装、部署、连接器及其他外部写；不能用CLI工具入口放开整个Shell（05，不延后至08）。
5. Skill和Runtime自身todo/计划能力保留，平台工具不接管内部推理（08）。

历史文档有记录不代表目前实际部署版本一致；01A客户端合同、01C宿主选择测试均不构成任何Runtime验收。未经授权不进行可能计费的复测。

## Ticket01 integration 同实例只读快照

2026-09-30T15:52:09Z，通过既有账号的 `GET /api/workers` 与 `GET /api/workers/:id/capabilities` 获取。Worker脱敏指纹 `3ba914472855`，online；2026-09-30T15:56:59Z再次只读确认原身份在线。发布路径 `/opt/data/wemux-lite/releases/20260930-ticket01-dual-icons`。脱敏证据：`/tmp/wemux-ticket01-integration/recovery-validation.json`。此为API获取时间，API未提供逐Agent探测时间，不能伪称实时执行证明。

| Runtime | API版本 | availability / authorization | 模型数量/来源 | 证明边界 |
| --- | --- | --- | --- | --- |
| Pi | 0.87.1 | available / authorized | 33 / configured | 上报本机可执行路径；只证明能力探测与模型目录，不证明计费资格、Turn成功或新PRD工具 |
| OpenCode | 1.18.10 | available / unknown | 24 / configured | 上报本机可执行路径；未知认证不得算已认证执行 |
| Claude Code | null | unavailable / unknown | 0 | 上报候选路径不等于可用安装；执行未验证 |
| Test Agent | 1 | available / 未报告 | 1 / configured | 测试替身，不能算生产Runtime认证 |
| Codex | null | unavailable / unknown | 0 | 本轮接入范围外，无执行证明 |

未读取全局认证、未发送真实模型请求。模型切换/下一Turn快照、平台API、讨论写限制仍全部待04/05/08；05首次协调资格门不能后移。安装与发现版本修复不扩大讨论权限。

本轮隔离资源E2E另外验证官方托管Pi 0.85.1的安装、完整性校验、重启和能力探测（`resource-green.log`），并非将真实在线Pi降级或重装。父Pi环境 `PI_PACKAGE_DIR` 可使子Pi读取父包版本：同一已验证绝对入口继承环境报0.87.1，仅删除该变量报0.85.1。修复限于版本探针的子进程env副本，保留HOME/PATH和严格版本/integrity检查；不改Runtime执行认证环境。最初“可能官方工件版本不一致”已被对照反证，不再作为结论。
