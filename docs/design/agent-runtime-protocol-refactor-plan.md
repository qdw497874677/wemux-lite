# Agent 运行时与通用协议重构计划

状态：运行时重构的设计基线，部分代码已演进，本文的“当前事实”是制定时快照，不是最新完成清单。由 [路线图](../roadmap.md) M1 设计会话交互，M2 按功能需要承接未完成的运行时能力；本文内部 M1–M5 编号仅属于原重构计划，不对应产品路线图；产品方向见 [产品定位](../product-direction.md)。不据本文声明全部未实施或已交付。

## 1. 目标与范围

会话优先、任务看板辅助。用户可直接与任意已授权 Worker 上的 Agent 连续对话，发现并触发该会话可用的斜杠命令，查看运行时真实报告的模型用量。Task、Run、Review 保持现有管理语义，不成为自由会话前置条件。

本轮重构包括：

1. Worker 内统一的运行时会话 Interface，支持按需打开、恢复、跨 Turn 复用、空闲回收。
2. 通用命令发现、显式调用、持久结果及客户端入口。
3. Adapter 内解析用量，统一统计语义、Journal 持久化与客户端展示。
4. Pi 与 Claude 两个执行 Adapter，兼容旧历史，保留现有授权、队列、取消与断线同步。

不整体移植上游后端，不改为自建模型/工具 agent loop，不新增数据库或消息中间件，不在 Worker 安装时强制安装 Agent。

## 2. 当前事实与具体问题

已核对的代码事实：

- WorkerRuntime 保存执行中的 AgentTurnHandle，通过 startTurn 启动，再在 finally 中 stop；stop 目前兼有取消与释放进程职责。
- Pi/Claude 原生会话引用已可持久化。当前产品 Session 是持续的，但运行时进程按 Turn 创建。
- 每 Session 有持久 FIFO 消息队列；重启后未开始消息恢复，进行中 Turn 标为 interrupted，不自动重放。
- Session Journal 在 Worker 先落盘后同步；Server 会明确拒绝未知 event kind，协议版本目前固定为 1。
- SessionExecutionSpec 固定 Workspace、Agent 和 Model。不得通过原生命令悄悄改变绑定。
- launch context 按 Turn 创建目录、指令、技能和 capability token，执行结束删除目录。Pi 扩展与 Claude MCP 目前会在进程启动时读到本轮上下文。
- Worker 无事件超时与执行总超时混在信号等待中；若增加周期 usage 信号，不能让卡死进程仅靠统计心跳无限续命。
- 用量与命令尚未形成端到端统一合同。现有通用类型主要是文本、工具、消息、Turn 状态。

因此不是只给 UserMessageInput 加一个字段：需要同时调整生命周期、执行队列、事件合同和迁移顺序。

## 3. 架构决策

### 3.1 采用的组合

- Paseo：参考并选择性移植会话 Interface、命令分派、生命周期和用量更新防竞态实现。
- OpenDesign：参考声明式 CLI 定义、共享传输驱动、纯事件解析器。
- Wemux：保留分布式控制面、权限、持久命令/FIFO、Journal、Task/Run/Review。

选用理由：会话管理有大量状态，不适合全塞入配置对象；二进制、参数与协议种类适合声明式定义。无需为每种 Agent 重写所有启动逻辑，也不强迫所有原生行为成为一套万能配置。

### 3.2 Worker 内的职责

```text
Server / 客户端：只理解 Wemux 通用协议
                    ↓
WorkerRuntime：持久请求、队列、执行状态、Journal
                    ↓
RuntimeSessionManager：互斥、打开/恢复、复用、回收、故障隔离
                    ↓
Provider Adapter：命令、模型、原生事件及用量语义
                    ↓
共享传输驱动：JSONL / Pi RPC / 后续 ACP
                    ↓
本机 Agent CLI
```

RuntimeDefinition 描述可信内置/管理员配置的可执行路径、参数构造、版本和能力探测。远程客户端不能提交任意 executable、argv 或 shell 片段。不要为了当前两个 Adapter 预建完整插件框架。

### 3.3 小 Interface，深 Implementation

调度方只需知道：获取某 Session 的执行租约、执行一种已授权操作、接收通用事件、请求中断、释放租约。进程复用、原生 RPC 编号、部分 JSONL、退出升级和轮询 generation 留在 Module 内。

Adapter 的会话能力包含：

- 打开/恢复原生会话，返回可靠 native handle 与 capabilities。
- execute(message 或 command)，输出单一操作关联的事件流，恰好一个终态。
- discoverCommands，返回有版本和状态的目录。
- interrupt(operationId)，只中断指定活动操作。
- close，幂等释放进程，不删除原生历史。

实现期间可用临时桥接器包裹现有 startTurn；迁移完成后删除桥接器，不能永久保留两套取消/执行状态机。上层不必知道是否有常驻 PID。

## 4. 生命周期、授权与并发

### 4.1 两种生命周期分开

产品 Session、原生持久会话、Worker 当前运行时实例分别识别；运行时实例带 generation，不能把新进程事件写到旧操作。

内部状态：closed → opening → ready → busy → ready；closing/faulted 单独处理。产品的 idle 不要求运行时常驻，不能对外暴露一个假 running 只为了表示进程活着。

规则：

- 一 Session 同时一个活动操作；同一 native handle 不允许两个进程并发写。
- 取消本轮默认保留后续队列。原生 interrupt 无法确认已停止时，升级终止进程，确认退出后才允许下一项。
- 取消发生在打开过程中也须生效，不能漏掉尚未登记的 handle。
- 空闲实例按 TTL 和 Worker 级数量上限回收；不驱逐活动实例。初始建议 TTL=5分钟、最多4个空闲实例，可配置并在验证后调整。
- 回收与租约获取在同一互斥下处理；close 结束前不可把同一 native handle 交给新实例。
- Worker 停机等待活动操作收尾并关闭全部实例。启动失败、输出管道错误、超时均有一次且仅一次终态。
- Worker 重启不恢复旧 PID，不自动重放已开始的消息或命令；标记 interrupted/结果未知，恢复尚未开始的 FIFO。
- Server 断线不立即杀进程，继续本地落盘；重连补传。受保护工具调用仍须经过授权验证，不能离线绕过检查。

分别设置启动超时、操作最大时长、进程活性检查与可取消关闭超时。usage/心跳不作为用户执行进展，也不能刷新最大时长。

### 4.2 授权不能随进程永久保留

每次操作仍获取独立授权快照。复用判断覆盖 Session 绑定、可执行文件/版本、指令/技能内容及工具配置；secret 不写入指纹、日志或 Journal。

分两步安全交付：

1. **保守复用阶段**：只复用没有按轮敏感 launch context 且配置未变的实例。受保护 Turn 继续重开/恢复原生会话，保留现有权限保障；不可宣称这时全部会话已复用。
2. **完整复用阶段**：实现 Worker 内的操作级 capability broker。进程持有本地、最小权限的连接标识，不持有长期有效的上一轮 Server bearer token。每次受保护调用验证 Session、当前 operation generation 和当前令牌；操作结束/取消撤销，旧 generation 的延迟调用必须拒绝。只有原生工具桥接能可靠传递并验证调用归属时才允许复用，否则继续重开。

稳定的进程级资源放会话级目录；不可变技能/指令资产按内容版本保留至最后一个租约释放。按轮令牌与临时资源执行后清理；目录内容改变且运行时无法可靠重载时关闭后恢复。不能只是取消当前 cleanup 来“修复”复用。

这里不承诺撤销已交给 Agent 的知识或文件权限；跨用户/敏感任务的文件与历史隔离仍依赖独立 Workspace/Session。

## 5. 斜杠命令合同

### 5.1 发现

命令目录以 Session 的工作目录、Agent 版本、技能/扩展配置为上下文。包含目录 revision、发现时间、fresh/stale/unavailable 状态；空目录与查询失败不同。

命令描述包含 name、description、argumentHint、kind(command/skill)、executionMode(prompt/control)、availability 及原因。能力清单只是可用性说明，不是授权凭证。

发现可按需唤醒运行时但不得执行 prompt。忙碌时仅使用明确安全的原生查询，否则返回已有目录及 stale/稍后刷新；不并行注入可能修改状态的查询。

### 5.2 显式调用与队列

客户端提交独立 requestId、command name、原样参数、catalogRevision。不是 shell；不做 shell 拆词或环境变量展开。普通消息内容不在 Server 被启发式转成命令。

使用同一个 Session FIFO 承载 message 和 slash-command 的操作封装，避免两个队列争抢原生会话：

- message 操作保持现有 messageId、Turn 和队列语义。
- prompt 型命令在原队列位置执行，创建 Turn 并关联 operationId。
- control 型命令不伪造模型 Turn，有自己的 started/result；同样遵守串行执行。
- 中断指定活动操作走独立控制路径，不能排在被中断操作后面。

迁移旧 queued message 时保持顺序/身份不变。命令记录至少包含 accepted、queued、running、completed/failed/cancelled/interrupted；ACK 仅代表持久接收。重复 ID 同载荷返回原记录，不同载荷冲突；指纹包含命令名、参数、目录 revision，不包含可轮换的 bearer secret。

执行前再次验证实际支持、Session 绑定和配置 revision。目录过期且命令含义/能力已变时拒绝并要求刷新，不能改派相似命令。输出和错误以通用 Journal 事件持久化，结果大小受限，日志不泄漏 secret/native 私有路径。

### 5.3 第一版能力范围

- Pi：动态命令目录、经 RPC 明确支持的 prompt/技能命令；compact 走原生专用操作，并以 RPC 结果为终态，不等待模型回复。autocompact 仅在本轮验证其会话持久语义后启用。
- Claude：先以本机 CLI 协议探针确认发现和调用机制；未证实前明确 unsupported，不伪造目录。Paseo SDK 的 supportedCommands 不能当作 CLI 保证。
- 改模型、切目录、新建/切原生会话等会破坏现有 Session 绑定的命令暂不开放；引导创建新 Session。
- 依赖扩展交互的命令本轮明确失败或禁用，不自动 confirm=true。完整远程权限/表单交互为后续独立能力。
- compact 也可能调用模型并产生费用，不标成“零用量本地命令”。

第一版 Web 在会话输入框输入 / 展开过滤菜单，展示参数提示与不可用原因。选择后显式以命令提交，正在执行、失败、取消可见。以 / 开头但用户想发送的普通文本提供明确“作为文本发送”；UI 不承诺 Agent 本身不会解释原始 / 文本，Adapter 有转义能力才使用。

## 6. 用量与上下文合同

### 6.1 原生解析只在 Worker

公共类型不暴露 Pi/Claude 私有字段。每个记录包含 scope(message/operation/native-session)、稳定 subjectId、source、revision、snapshot 语义，可选 model，以及可选非缓存输入、输出、缓存读取、缓存写入、runtime-reported total、cost/currency。

**首版公共事件统一为快照，不同时发布可累加 delta。**原生增量在 Adapter 内按稳定请求 ID 归并；公共快照以统计主体和 revision 替换，减少上层出错面。

- 数值必须有限、非负；Token 为安全整数；缺失为未知，真实 0 保留。
- 原生 input 是否包含缓存必须在 Adapter 文档和测试中明确。不能归一的字段不伪装成非缓存输入，不凭字段名猜总量。
- message 明细、operation 汇总、native-session 累计是不同视图，不能混加。
- Session 页面首版优先展示每次操作用量；缺少完整明细时标“已知用量/部分”，不宣称精确总消费。原生会话累计单独标注，可能包含平台接管前历史。
- 费用仅显示原生报告，来源标明；多币种不相加、不估算价格、不把订阅账单等同该金额。
- 多模型执行分别保留明细；无法确认模型时不随意归因给 Session 选择值。

context.usage 是独立的当前占用/容量快照。压缩后占用可下降，累计消费不倒退。UI 不用累计 inputTokens 画上下文进度条。

### 6.2 采集与事件顺序

Pi 优先按原生 assistant/message 身份解析用量；session stats 用于单独累计/上下文快照，不与逐条数据双计。Claude 以实际 CLI 数据解析，明确 result 的统计范围，避免同时累加 partial assistant 与 result。

优先事件驱动。需轮询的指标只在有效租约期间采集，初始间隔3秒；同一查询最多一个在途，generation 防止迟到结果跨操作/进程污染；限流、去重、设置超时。采集失败不使已成功对话变失败，保留上一快照并标明陈旧。

操作终结前做有界最终采集，先落最终已知用量再落终态。取消或失败也保留已知消费；超时不等待无限查询。操作终态后不追加归属于旧操作的迟到事件。Journal 是重放来源，不依靠前端内存累加。

## 7. 协议、持久化与兼容

### 7.1 明确升级版本，不伪装完全向后兼容

本次采用 Worker wire protocol v2，Server 在迁移期明确支持 v1/v2 两套校验与会话连接版本。旧 Worker 继续普通聊天；命令/用量入口仅在 v2 且运行时声明能力时启用。缺少能力不代表隐式支持。

升级顺序：先 Server 读新旧事件/合同，再 Worker v2，再启用 Web 新功能。新 Worker 遇到旧 Server 明确提示需要升级，不静默把命令当聊天降级。

一旦 Journal 已写新事件，不能通过丢掉这些 seq 向旧 Server“兼容同步”，否则造成 gap 或虚假完整。也不能声称直接回退旧二进制仍能读新数据。

### 7.2 数据变化

- Worker 增加持久 Session operation 队列/结果字段，将旧消息包成 message 操作；保留 commandId/messageId/Turn 关联。
- 扩充 Journal 的命令目录结果、操作状态、命令输出、用量及上下文事件。
- Server 增加 operation 投影与命令目录缓存；实际执行和历史仍以 Worker 为准。
- 运行时进程 Map、PID、租约状态不作为可恢复进程存储。native handle 继续 Worker 私有，不将本地路径当成客户端恢复句柄。
- 命令发现刷新与调用都是带关联 ID 的受授权请求，结果可查询；离线时不伪造新鲜目录。读取目录亦须保护 Session 信息。
- HTTP/其他客户端沿用既有鉴权；调用同时满足 Session 写权限与 Worker 使用权限，发现/结果读取满足对应资源访问权限，审计不记录完整参数正文。

所有新增事件同步更新两端 runtime validator、DTO、Journal 投影、SSE/分页；Task Run 投影只能消费所属消息 Turn，不把控制命令完成解释为 Run 成功。新能力不得扩大 Session 内容可见范围。

## 8. 小提交实施序列

每步保持构建与已有测试通过；未完成的能力不对外开放。下表是提交粒度，实际执行按5个里程碑验收，不另建几十张票。

| 提交 | 内容 | 独立验收/安全回退 |
|---|---|---|
| 01 | 固化当前 Pi/Claude、FIFO、取消、重启、授权清理基线 | 原生协议桩通过；不改行为 |
| 02 | 建立上游来源/许可台账，提取纯用量与事件映射测试样本 | 保留原输出；来源可核对 |
| 03 | 提取最小共享子进程/JSONL/RPC 生命周期 Module | 缺半行、EPIPE、退出竞态与清理通过 |
| 04 | 引入运行时会话 Interface，以旧 startTurn 桥接 | 旧 Adapter 行为等价，无新对外能力 |
| 05 | 实现 RuntimeSessionManager 租约、generation、TTL/上限 | 假时钟验证打开/取消/回收竞态 |
| 06 | Pi 支持跨轮连接与可靠 native handle | 同配置无敏感上下文两轮只启动一次；异常不重放 |
| 07 | 明确 launch context 兼容指纹及受保护场景强制重开 | 保留现有令牌/资产清理，禁止旧权限串轮 |
| 08 | 操作级 broker、资产租约与工具桥接归属校验 | 旧 generation 调用被拒；验证通过才开放受保护复用 |
| 09 | Claude CLI 实机协议探针与适配决策记录 | 确认持续 stdin、终态、恢复、命令发现；不凭 SDK 推断 |
| 10 | Claude 接入新会话 Interface | 支持则保活，否则明确按轮恢复；无隐藏 SDK/Agent 安装 |
| 11 | 新增 v2 公共合同及双版本校验，暂不发送新事件 | Server 可处理 v1；v2未知/非法载荷拒绝 |
| 12 | Worker operation FIFO 和结果迁移 | 保留旧消息顺序；重启/重复 ID/取消均正确 |
| 13 | Server operation 路由、权限与结果投影 | ACK与完成分离；未授权不可发现/调用/读取 |
| 14 | Pi 命令发现及专用 compact/control 路径 | 无 assistant 输出也终结；重复请求不重复执行 |
| 15 | 接入已证实的 Claude 命令，其他明确 unsupported | 目录与真实运行能力一致；交互不自动批准 |
| 16 | Adapter 输出规范化用量与上下文快照 | 缺失/零/缓存/多模型/重复/压缩样本通过 |
| 17 | 用量持久化、重放和上下文投影 | Server重启、重连分页不翻倍，不串 native epoch |
| 18 | Web命令菜单、参数输入、运行结果和取消 | 手机键盘/触控、纯文本路径、陈旧目录与失败恢复 |
| 19 | Web每次执行用量与上下文展示 | 未知非零、部分数据标注、费用来源与统计范围可辨 |
| 20 | 全链路验证、删除临时桥接、更新文档及发布门禁 | 两Adapter、两Worker、旧数据升级、回退演练通过 |

里程碑：M1=01–07 生命周期；M2=08–10 授权与双 Adapter；M3=11–15 通用命令；M4=16–19 用量与客户端；M5=20 发布。09 的探针可提前做，但不必为此并行修改同一文件。

Claude SDK 不是预设依赖。若探针显示 CLI 无法支持需要的能力，再提交独立取舍：可选适配包 vs 保持明确能力限制；核对安装边界后决定，不能无声引入全套 SDK。

## 9. 测试与验收

已有测试基础：Worker 的 worker/pi-rpc/agent-bridges/capabilities 测试已覆盖 FIFO、真实WS、RPC恢复、取消、超时、扩展注入与清理；Server 有 capability-token、task-runs、reuse-rejections；Web 有源码合同与纯逻辑测试。当前未重新运行这些测试，本文件不把历史结果当本轮验收。

新增测试尽量穿过实际 Interface，使用真实子进程协议桩和SQLite，不用大量断言私有方法调用次数替代业务结果。进程复用可额外记录桩启动次数，因为这是本轮明确的外部资源目标。

必须通过：

- 连续两轮回复、原生上下文恢复、共享进程没有重复消息/漏终态。
- 两 Session 不串事件、不共享错误 native handle；空闲回收不杀活动操作。
- 中断、启动中取消、Worker退出、子进程崩溃、超时及迟到响应均可恢复。
- message/command 混合 FIFO；重复请求、取消排队、控制命令无模型输出的终态。
- Pi compact 和至少一条真实可发现 prompt/技能命令；Claude仅对证实支持的能力验收。
- 操作A工具延迟回调不能使用操作B授权，目录版本改变不能继续读取已删除旧资源。
- 增量原生数据归并、累计重复、部分字段、无费用、取消、上下文压缩、session重启后统计正确。
- v1 Worker→新Server聊天；v2 Worker→旧Server明确拒绝；新Journal降级不丢seq。
- Server→Worker→原生协议桩→Journal→Web端到端，以及有凭证时真实 Pi/Claude 验收。没凭证只能报告测试桩通过，不能宣称真实模型通过。
- 390/768/1440px 的命令菜单、参数、取消与用量布局；保持现有Markdown、快速会话与不安全HTTP上下文回归。

构建顺序遵循仓库要求：改packages后先 build:packages；再typecheck、全测试、全构建、Worker pack检查。证据存 `.scratch/agent-runtime-protocol/evidence/`，不提交凭据、原始私密聊天或本地构建产物。

## 10. 发布、回退与风险

先整理当前未提交的前端改动作为明确基线，不覆盖或混入运行时重构提交。实施期间使用动态端口验证，不占用禁用端口8004；未验收不替换8010手工环境。

Feature gates 分开控制持久复用、命令入口和用量发布。出现故障时首先关闭复用并保留 v2 reader：受影响操作安全终结后，以相同 native handle 按轮恢复；不能把活动命令转成普通文本重试。

数据库升级前备份。写入新Journal后的普通回退使用已支持新合同的维护版本并关闭新功能；回退到完全不识别新schema/事件的旧二进制，只能恢复停机备份并明确其后的数据损失，不允许静默忽略新事件。

最大风险排序：
1. 跨轮授权泄漏：M2门禁，不通过不开放受保护复用。
2. 非幂等原生命令在崩溃后重复：已开始操作不自动重放，结果未知可见。
3. 统计范围混淆：公共快照与scope先定，后做UI。
4. 原生CLI版本漂移：版本/能力探针、固定测试样本、明确不支持原因。
5. 上游代码耦合：只抽独立模块及测试，不依赖整个Paseo/OpenDesign服务包。

## 11. 上游与范围外事项

参考固定版本与研究证据见：
- `docs/research/paseo-agent-protocol.md`
- `docs/research/opendesign-agent-runtime.md`

移植时记录来源提交、原文件、许可证、修改摘要；Apache-2.0副本、版权与适用NOTICE随源码/包分发，单独检查第三方部分。不为了移植复制无关功能或secret。

本轮不包含：任意远程shell、自动批准权限、任意原生Session导入、运行中更换Session绑定、多活跃Task Run、多Server、高可用、完整ACP生态、全部上游Provider、费用结算系统。

现有CONTEXT.md还残留“Pi/Claude仅检测、看板主入口”的旧实现说明，与代码及会话优先方向不一致。实施的文档清理提交修正这些事实，领域词汇保持Session/Native Session/Turn区分；Runtime Session只表示Worker内部技术句柄，不把Agent改称进程。

## 12. 代码落点索引（非接口承诺）

- domain/session.ts、journal.ts、agent.ts：操作、能力、用量与标准事件。
- wire-protocol/commands.ts、messages.ts、envelope.ts：v2命令和握手；web-contract：DTO。
- Worker application/runtime.ts、ports/agent-adapter.ts：调度与新Interface。
- Worker application/agent-launch-context-provider.ts、capabilities：令牌/资产寿命。
- Worker agents/pi-agent.ts、pi-rpc.ts、claude-agent.ts：原生Adapter与驱动提取。
- Worker storage 与现有迁移机制：FIFO与操作结果。
- Server application/validation.ts、worker-service.ts、server-service.ts、run-projection.ts：协议、路由与投影。
- Web api/journal.ts、features/sessions/conversation.tsx及Composer：回放、命令、用量。

具体文件拆分以实施时保持职责集中为准，不为上述名字再建一层只有转发的Module。
