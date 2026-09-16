# OpenDesign Agent 运行时集成调研

研究对象：nexu-io/open-design。固定源码提交 `39de577a5d4cd78b79da568af02c08b4f65676f1`。仅源码与官方文档审阅，未运行该项目；不修改 Wemux 产品代码。GitHub API 直连曾 DNS 失败，改用 git ls-remote 固定提交并通过内容工具读取原始源码。适配器概览读于 main，关键 Pi 行为已由固定版本源码核实。

## 结论

OpenDesign 的强项是“声明式运行时定义 + 共享传输/解析”，Paseo 的强项是“会话级运行时抽象 + 多轮交互能力”。建议 Wemux 采用二者组合，而非整体复制任一产品。

## 核实的实现

- `RuntimeAgentDef` 声明二进制、版本探测、参数构造、streamFormat、eventParser、模型发现、认证探测及 MCP 注入方式。普通 CLI 复用已有传输时主要新增定义文件和注册项；新协议仍需要解析器，不是所有 Agent 均可零代码接入。[S1][S2]
- 模型调用、工具循环、上下文管理由外部 CLI 承担；daemon 组织 prompt/技能/cwd、启动进程并转换事件。无需重写 agent loop。[S1]
- transport 分为 claude-stream-json、json-event-stream、acp-json-rpc、pi-rpc、plain 等；不强迫不同原生协议伪装成同一种协议。[S1]
- Pi `attachPiRpcSession` 接收已启动 child，负责发 prompt、解析 stdout、abort 与会话路径捕获。`agent_end` 后关闭 stdin，默认 5000ms 后 SIGTERM。该实现为单次 /api/chat 服务，并非跨 Turn 驻留的会话池。[S3]
- Pi 恢复路径使用 `new_session({parentSession})` 并等待响应；从 cwd/.pi/sessions 的 mtime/size 变化捕获唯一会话路径，歧义时返回 null。这是该项目实现，不作为原生 Pi 恢复语义正确性的证明。Wemux 已有 get_state.sessionFile / --session 路径及 agent_settled 生命周期，不应因移植而倒退成扫描猜测或过早结束。[S3]
- Pi 事件转换是无 I/O 的纯映射：在原生 turn_end 读取 input、output、cacheRead、cacheWrite、totalTokens、cost；message_end 不再次提取，从源事件选择上避免重复。不能将原生 turn_end 自动等同 Wemux 用户请求级 Turn，一个请求可包含多个模型/工具回合。[S4]
- ACP 文档明确 initialize → session/new 或 session/load → 可选模型设置 → session/prompt → session/cancel。stdout 为协议，stderr 为日志；prompt 完成后关闭/回收进程。文档提到的远程 ACP 状态仅代表该文档描述，不据此断言当前整个 ACP 生态状态。[S5]
- Pi extension UI 自动 confirm=true，select 默认第一项；ACP 文档也采用优先批准权限请求的策略。这符合其非交互设计选择，但不适合直接作为我们的多 Worker 控制台默认策略。[S3][S5]
- 根 LICENSE 为 Apache-2.0。代码移植仍需逐文件核对归属、NOTICE 与依赖许可，保留声明并标明修改。[S6]

## 对照与选型

| 维度 | OpenDesign 已核对路径 | Paseo 已核对路径 | Wemux 建议 |
|---|---|---|---|
| 声明接入 | RuntimeAgentDef + 注册表 | AgentClient/Provider 配置 | 用声明描述启动/探测，不描述全部状态机 |
| 会话 | Pi 按请求启动/关闭，保存恢复句柄 | AgentSession 操作与资源释放分离 | 按需启动、跨 Turn 复用、空闲回收 |
| 协议共享 | 多 CLI 共用 transport/parser | 原生 Provider + 共用 ACP 基类 | 传输驱动共享，特有行为留 Adapter |
| 用量 | Pi 原生 turn_end 事件解析 | Pi session stats 轮询与结束采集 | 事件优先；累计快照与单消息消费分开 |
| 命令 | 本轮未核实完整通用发现/调用合同 | listCommands 与 Pi 特殊命令分派 | 以 Paseo 的命令能力为主要参考 |
| 权限 | 多个非交互路径自动批准 | 统一权限请求/响应接口 | 保持现有授权边界；未支持交互时拒绝或明确提示 |

## 建议 Worker 内部结构（尚未实施）

```text
RuntimeDefinition：可执行文件、argv、探测、协议类型
RuntimeSessionManager：并发互斥、按需打开/恢复、租约/回收
ProtocolDriver：Pi RPC / Claude stream-json / 后续 ACP
ProviderAdapter：命令语义、原生事件与用量归一
现有 Worker 持久队列与 Journal：幂等、顺序、断线同步
```

这是职责划分，不要求先建设五个大框架。先从现有 Pi/Claude Adapter 提取可复用部分，保留必要的原生分支。首轮只接 Pi/Claude，不预填几十个未经测试的 Agent 定义。

特别约束：跨 Turn 复用必须重新处理每轮 capability token、工具授权和 launchContext；不可把上一轮权限随进程永久保留。命令完成不一定伴随模型输出，用量更不等于执行成功。保留 accepted 与 completed 的区别，恢复失败不静默新建上下文，故障重启不自动重放可能已执行的消息。

## 来源

- [S1] https://github.com/nexu-io/open-design/blob/main/docs/agent-adapters.md
- [S2] https://github.com/nexu-io/open-design/blob/39de577a5d4cd78b79da568af02c08b4f65676f1/apps/daemon/src/runtimes/types.ts
- [S3] https://github.com/nexu-io/open-design/blob/39de577a5d4cd78b79da568af02c08b4f65676f1/apps/daemon/src/agent-protocol/pi-rpc/session.ts
- [S4] https://github.com/nexu-io/open-design/blob/39de577a5d4cd78b79da568af02c08b4f65676f1/apps/daemon/src/agent-protocol/pi-rpc/events.ts
- [S5] https://github.com/nexu-io/open-design/blob/39de577a5d4cd78b79da568af02c08b4f65676f1/docs/new-agent-runtime-acp.md
- [S6] https://github.com/nexu-io/open-design/blob/39de577a5d4cd78b79da568af02c08b4f65676f1/LICENSE

Paseo 对照依据见 `docs/research/paseo-agent-protocol.md`。
