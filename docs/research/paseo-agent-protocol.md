# Paseo 对通用 Agent 协议的启发

状态：源码调研与实现约束，尚未实现协议改动。用户要求通用协议在 Worker 内适配不同 Agent 运行时。

## 核对范围

官方仓库 getpaseo/paseo，固定提交 `0eac75be7dd11a6623abb763b3a44d23e711c550`。仅阅读源码，未运行 Paseo。Wemux 对照：`packages/domain/src/{session,journal}.ts`、`packages/wire-protocol/src/commands.ts`、`apps/worker/src/application/ports/agent-adapter.ts`、`apps/worker/src/agents/{pi-agent,claude-agent}.ts`、`apps/web/src/api/journal.ts`。

## 事实与设计取舍

1. Paseo 以 AgentClient / AgentSession 隔离 provider。Session 有可选 listCommands，统一 AgentSlashCommand 包含 name、description、argumentHint、kind（command/skill）。其类型注释以带 / 的 prompt 作为命令执行入口，但具体 provider 有特殊分派，不是无差别文本透传。[S1][S2]
2. Pi 映射 getCommands 的发现结果，并补充 compact、autocompact；tryHandleOutOfBand 对这两类操作走专门实现。这说明原生 TUI 内置命令不能假定由 RPC prompt 自动执行。[S2]
3. Claude 使用 SDK query.supportedCommands() 获取命令。Wemux 目前使用本机 CLI stream-json，不使用该 SDK，不能直接调用这个方法或凭此认定 CLI 暴露相同能力。CLI 命令发现与调用须另行核对；不支持时明确报告，不为复用 Paseo 引入 SDK 依赖。[S3]
4. AgentUsage 含 inputTokens、cachedInputTokens、outputTokens、totalCostUsd、contextWindowMaxTokens、contextWindowUsedTokens；usage_updated 与 turn_completed 都可能携带用量。不能看到用量事件就累加。[S1]
5. PiUsagePoller 每 3 秒读取 session stats，结束时最后读取一次；按字段去重，并通过 generation 抛弃过期响应。它读的是 session stats，即使事件带 turnId，也不能直接视作该 Turn 独占用量。[S4]
6. Claude 独立跟踪上下文占用、压缩和结果用量，结果来自 usage / total_cost_usd / modelUsage；上下文占用不是会话累计 Token。[S3]
7. Paseo Pi 用量映射部分缺失字段默认 0，公共类型未显式区分 scope 或缓存写入。本项目不照搬：未知保留未知，缓存写入单列，统计范围明确。[S1][S4]

## Wemux 推荐落点

```text
客户端 → Server（鉴权、路由、持久化）→ Worker（调度、Journal）
                                         ├─ Pi Adapter → Pi RPC
                                         └─ Claude Adapter → Claude CLI
```

- 公共类型归 domain，跨节点请求归 wire-protocol，客户端 DTO 归 web-contract。原生 JSON 解析仅在 Worker Adapter，Server/Web 不按 Pi/Claude 字段分支。
- 命令发现以 Session/Workspace 的真实配置为上下文，不能把全局 Agent 探测当作项目命令清单。需区分未发现、发现失败、确实为空；目录、技能或扩展变化需刷新。
- 采用显式命令调用意图（名称、参数、请求 ID），由 Adapter 区分原生命令 API 与经运行时支持的 prompt 命令。UI 的 `/` 补全只是通用请求的输入方式。未知或需本地交互命令返回不支持，不转 shell、不静默降级为普通聊天。
- 非模型命令也必须有确定的完成/失败事件；不能只等待 assistant 消息或 agent_settled。会改变会话、模型或目录绑定的命令需单独约束，不破坏已有 Session 绑定。
- 用量推荐事件携带 scope（message/turn/native-session）、统计主体 ID、mode（snapshot/delta）、来源，以及可选模型。Token 分为非缓存输入、输出、缓存读取、缓存写入；Adapter 必须核实原生字段是否含缓存，不能重复相加。无法可靠归一时标明语义，不伪造总数。
- 费用记录运行时报告的金额/币种，不用 UI 猜价格。上下文使用量与容量作为独立快照；不得拿累计消费画上下文进度。
- 快照按统计主体替换，delta 按稳定事件标识去重；native session 恢复或更换后不能混用基线。Journal 重放、分页、重连不得翻倍。
- Worker 目前每 Turn 启动并关闭原生进程，Paseo 有持久 Session 与轮询管理。先保证结束前可靠采集、取消/失败时保留已报告数据，再按需求增加有生命周期约束的实时更新，不直接搬长连接实现。

## 接下来实现时的验收

- Pi RPC 与 Claude CLI 分别用原生协议测试桩验证命令能力及用量，不只测公共类型。
- 命令重复请求、忙碌状态、未知命令、无模型输出命令、交互命令拒绝，都有可观测且不重复执行的结果。
- 用量缺失、真实零值、多个 assistant 回合、累计快照重复、恢复历史、取消和错误结果不重复计费。
- 老 Worker 未声明新能力时客户端隐藏或禁用相应入口，不能假定能处理新 command/event；更新 packages 后先构建再校验下游。

## 一手来源（固定版本）

- [S1] https://github.com/getpaseo/paseo/blob/0eac75be7dd11a6623abb763b3a44d23e711c550/packages/server/src/server/agent/agent-sdk-types.ts
- [S2] https://github.com/getpaseo/paseo/blob/0eac75be7dd11a6623abb763b3a44d23e711c550/packages/server/src/server/agent/providers/pi/agent.ts
- [S3] https://github.com/getpaseo/paseo/blob/0eac75be7dd11a6623abb763b3a44d23e711c550/packages/server/src/server/agent/providers/claude/agent.ts （listCommands、ClaudeContextUsageTracker/buildResultUsage）
- [S4] https://github.com/getpaseo/paseo/blob/0eac75be7dd11a6623abb763b3a44d23e711c550/packages/server/src/server/agent/providers/pi/usage-poller.ts
- [S5] https://github.com/getpaseo/paseo/blob/0eac75be7dd11a6623abb763b3a44d23e711c550/docs/providers.md
