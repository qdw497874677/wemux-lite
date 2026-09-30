# Worker 可靠长连接模块设计

状态：设计基线。R0/R1 首个切片已于 2026-09-17 实现并验证；transport v2、持久 outbox/inbox、ACK cursor 和 Journal epoch 尚未实现。

已完成的 R0/R1 范围：

- Worker v1 transport 暴露 `snapshot()`，区分 `stopped | connecting | online | backoff`；
- Worker 快速连接抖动保留指数退避次数，并使用 full jitter；
- 连接持续在线达到稳定窗口后才清零退避；
- `stop()` 取消 reconnect、heartbeat 和稳定窗口 timer；
- Server 允许同一 Worker 的新连接在有效 hello 后接管；
- active connection 使用进程内 epoch 隔离旧 socket 的 message/close 回调；
- 同一 Worker 的 hello、消息和 offline 变更串行化；
- 本切片未修改 `@wemux/wire-protocol` 或 `@wemux/agent-interchange` schema。

验证：`npm run typecheck`、`npm test`、`npm run build`、`npm run pack:check --workspace @wemux/worker` 和 `git diff --check` 均通过。当前 full test 结果为 Server/Worker/packages 401 通过、4 条条件跳过，Web 125 通过。

相关文档：

- [Agent 互操作模块](agent-interchange-module.md)
- [Reliable Worker command delivery](../adr/0003-reliable-worker-command-delivery.md)
- [Worker 长连接开源复用调研](../research/worker-long-connection-open-source-reuse.md)
- [产品方向](../product-direction.md)
- [领域术语](../../CONTEXT.md)

## 1. 决策摘要

Worker 与 Server 继续使用一条由 Worker 主动建立的原生 WebSocket 长连接。近期不引入 Socket.IO、Centrifugo、NATS、MQTT Broker 或其他外部消息基础设施，而是在现有 `ws + node:sqlite` 上实现版本化的 **Wemux Reliable Transport v2**。

该模块负责：

- 物理 WebSocket 建立、关闭、重连和候选地址轮换；
- Worker 身份认证后的 transport 与 Wemux ADK Profile 协商；
- 一条连接内控制、管理、Session 和 Invocation 消息的多路复用；
- 两个方向独立的持久 outbox、inbox、sequence、ACK、去重和重放；
- 有限 inflight、流量优先级、背压、过期和容量保护；
- 连接恢复失败后的明确降级与完整重同步；
- 可诊断但不泄露对话内容或凭据的连接状态。

该模块不负责：

- 将 Pi、Claude Code、Codex 等 Provider 输出转换成统一 Event；
- 定义 Session、Invocation、Content、Event、Approval 或终态语义；
- 决定 Project、Workspace、Task、Run 和权限规则；
- 把 Server 缓存升级为 Session 历史权威；
- 将 transport ACK 解释为 Agent 已完成工作；
- 为每个 Session 创建独立连接。

## 2. 不影响 Wemux ADK 兼容协议的结论

**只要严格遵守本设计的分层，完善长连接不会破坏 Agent 对话的 ADK 兼容协议。**

两者关系是：

```text
Pi / Claude / Codex / 其他 Agent
              │ Provider 原生 SDK、CLI、JSONL、RPC
              ▼
┌──────────────────────────────────────────┐
│ Agent Adapter Bridge                     │
│ 原生事件 → Wemux ADK Profile             │
└──────────────────────────────────────────┘
              │ Session / Invocation / Event
              ▼
┌──────────────────────────────────────────┐
│ Agent Interchange Module                 │
│ 互斥、Session 生命周期、持久 Event、终态  │
└──────────────────────────────────────────┘
              │ ADK Profile payload
              ▼
┌──────────────────────────────────────────┐
│ Reliable Worker Connection Module        │
│ transport frame、ACK、重放、背压、恢复    │
└──────────────────────────────────────────┘
              │ 一条主动出站 WebSocket
              ▼
            Server
```

以下是不允许被实现破坏的兼容不变量：

1. **Wemux ADK Profile 是唯一对话契约。** Worker 本地 Web 和集群 Server 使用同一套 Session、Invocation、Event、Content、Action、Approval、Cancel 和终态语义。
2. **transport envelope 不是 ADK Event。** `messageId`、`directionSeq`、`deliveryEpoch`、`ackThrough`、`connectionEpoch` 不得写入公共 ADK Event 字段，也不得成为 UI 对话身份。
3. **领域身份跨重试稳定。** 对话调用始终使用原 `invocationId`；Event 始终使用原 `event.id`；网络重发始终使用原 `messageId`。重连不能生成新的领域身份。
4. **版本独立协商。** transport major/minor 与 Wemux ADK Profile 版本分别选择。升级可靠传输不要求修改 ADK Event schema；升级 ADK Profile 也不要求更换 WebSocket 实现。
5. **partial 与持久历史分离。** partial delta 是 volatile 实时数据，允许在断线或背压时丢弃；非 partial Event 先进入 Worker Session Journal，再参与可靠同步。
6. **连接状态不冒充执行状态。** socket 在线、transport ACK、command accepted、Invocation running、Invocation terminal 和 Task review 是不同事实。
7. **Provider Adapter 不感知集群连接。** Adapter 不处理 WebSocket、ACK、重连、Server 权限或 outbox。
8. **本地模式不依赖 transport。** Worker 本地工作台可以绕过集群连接，但必须复用同一个 Agent Interchange Module 和 Wemux ADK Profile。

因此，可靠连接模块是 ADK payload 的运输层，不是第二套 Agent 协议。

## 3. 模块边界

### 3.1 外部 Seam

对应用层暴露一个小而完整的 Interface。概念形状如下，最终命名可在实现切片中调整：

```ts
interface ReliablePeerConnection<OutboundVolatile> {
  start(): void
  wake(): void
  publishVolatile(message: OutboundVolatile): boolean
  snapshot(): ConnectionSnapshot
  stop(reason: StopReason): Promise<void>
}
```

语义：

- `start()` 启动连接状态机，幂等。
- `wake()` 表示持久 outbox 可能有新记录；调用方不传递待重试 payload。
- `publishVolatile()` 只发送允许丢失的实时消息；未在线或超过背压水位时返回 `false`。
- `snapshot()` 返回诊断投影，不返回对话 payload、Token 或 resume secret。
- `stop()` 停止重连、关闭 socket，并等待本连接已启动的本地清理完成；不删除 durable outbox。

可靠消息不通过 `send(message)` 直接写 socket。应用服务必须在写入领域事实的同一个 SQLite 事务内写入 transport outbox，然后调用 `wake()`。这避免以下崩溃窗口：

```text
领域事实已提交
    ↓ 进程崩溃
消息尚未进入 outbox
```

### 3.2 内部 Seam

连接模块内部允许存在以下 Seam，但不向 Agent Interchange Module 暴露：

```ts
interface TransportStore {
  listSendable(peerId: string, limits: SendLimits): Promise<readonly OutboxItem[]>
  markSent(input: SentAttempt): Promise<void>
  acknowledge(input: AckProgress): Promise<void>
  connectionState(peerId: string): Promise<PersistedConnectionState>
  recordNegotiation(input: NegotiatedConnection): Promise<void>
}

interface DurableInboundCommitter<Payload> {
  commit(input: DurableInbound<Payload>): Promise<InboundDisposition>
}

interface SocketAdapter {
  open(input: SocketOpenInput): Promise<SocketSession>
}
```

`DurableInboundCommitter.commit()` 的 Interface 合同要求 Adapter 在一个本地数据库事务中完成：

1. 按 `messageId` 查 inbox；
2. 若已处理，读取并返回原 disposition；
3. 若未处理，校验并应用领域副作用；
4. 写入 inbox/disposition；
5. 提交事务；
6. 事务成功后才允许连接模块发送 transport ACK。

Worker Adapter 和 Server Adapter 分别复用各自现有的 Store transaction，不建立第三个数据库。

### 3.3 删除测试

若删除该模块，以下复杂度会重新散落到 Gateway、WorkerRuntime、WorkerService 和各发送调用点：

- reconnect/backoff；
- handshake/version negotiation；
- ACK cursor；
- outbox replay；
- inbox dedupe；
- inflight/backpressure；
- socket replacement；
- diagnostics；
- shutdown ordering。

因此它应成为深 Module，而不是对 `ws.send()` 的浅包装。

## 4. 三层协议模型

### 4.1 Transport 层

只关心：

- peer 身份；
- 版本与 feature；
- durable/volatile frame；
- `messageId`；
- `deliveryEpoch + directionSeq`；
- ACK；
- 重连和恢复；
- frame 大小、inflight 和优先级。

### 4.2 Wemux wire payload 层

承载两类 payload：

1. **Wemux ADK Profile payload**：Invocation、Event、Command、Approval、Cancel、终态等对话执行语义；
2. **Management payload**：Worker capability、Workspace 操作、集群管理和 Journal 同步控制。

两类 payload 可以共享一条连接和 transport reliability，但不能共享领域身份或状态机。

### 4.3 Provider 层

Pi、Claude Code、Codex 等 Provider Adapter 只把原生输入输出映射为 Wemux ADK Profile。Provider 原生 session id 仍是 Worker 私有恢复信息，不作为 transport cursor。

## 5. Transport v2 frame

### 5.1 初始握手

Transport v2 的第一帧不复用 v1 `WorkerHello` 的含义：

```ts
interface WorkerTransportHello {
  readonly frameType: 'transport.hello'
  readonly side: 'worker'
  readonly transport: {
    readonly supportedMajors: readonly number[]
    readonly preferredMinorByMajor: Readonly<Record<string, number>>
  }
  readonly adkProfiles: readonly string[]
  readonly features: readonly string[]
  readonly workerId: WorkerId
  readonly workerVersion: string
  readonly platform: string
  readonly architecture: string
  readonly resume: {
    readonly logicalConnectionId: string | null
    readonly workerToServer: DeliveryCursor | null
    readonly serverToWorker: DeliveryCursor | null
  }
}

interface ServerTransportHello {
  readonly frameType: 'transport.hello'
  readonly side: 'server'
  readonly selectedTransport: { readonly major: 2; readonly minor: number }
  readonly selectedAdkProfile: string
  readonly enabledFeatures: readonly string[]
  readonly logicalConnectionId: string
  readonly connectionEpoch: string
  readonly resumeAccepted: boolean
  readonly authoritativeCursors: {
    readonly workerToServer: DeliveryCursor
    readonly serverToWorker: DeliveryCursor
  }
  readonly acceptedAt: Timestamp
}

interface DeliveryCursor {
  readonly deliveryEpoch: string
  readonly ackThrough: number
}
```

规则：

- HTTP upgrade 阶段先认证 Worker credential；hello 不能代替认证。
- 每次物理 socket 都重新认证，resume 不绕过 Worker 撤权。
- transport major 无交集时返回结构化 incompatibility 并关闭，不无限重试。
- minor 与 feature 只启用双方交集。
- `logicalConnectionId` 表示可跨短断线恢复的逻辑连接。
- `connectionEpoch` 每个物理 socket 都不同，用于隔离旧 socket 的迟到回调。
- 每个方向有独立 `deliveryEpoch + directionSeq + ackThrough`。
- Wemux ADK Profile 没有交集时，即使 transport 兼容也必须拒绝承载对话 payload。

### 5.2 Durable frame

```ts
interface DurableDataFrame<Payload> {
  readonly frameType: 'data'
  readonly durability: 'durable'
  readonly deliveryEpoch: string
  readonly directionSeq: number
  readonly messageId: MessageId
  readonly lane: 'control' | 'command' | 'journal' | 'snapshot'
  readonly payloadVersion: string
  readonly expiresAt: Timestamp | null
  readonly payload: Payload
}
```

不变量：

- `directionSeq` 在同一 peer、方向和 `deliveryEpoch` 内严格递增。
- `messageId` 在重传、重连、地址轮换和 epoch 重建时保持不变。
- `directionSeq` 不是 `invocationId`、`commandId`、Event `id` 或 `sessionSequence`。
- 接收端只能 ACK 已持久提交的连续前缀。
- payload 不因重试而使用新 encoder 重新解释；outbox 保存 `payloadVersion` 和序列化结果。

### 5.3 Volatile frame

```ts
interface VolatileDataFrame<Payload> {
  readonly frameType: 'data'
  readonly durability: 'volatile'
  readonly lane: 'realtime' | 'presence'
  readonly payloadVersion: string
  readonly payload: Payload
}
```

volatile frame：

- 不进入 outbox；
- 不分配 durable `directionSeq`；
- 不参与累计 ACK；
- 未连接、背压或恢复中均可丢弃；
- 只能承载 partial delta、typing/presence 和非权威诊断提示。

### 5.4 ACK frame

```ts
interface TransportAckFrame {
  readonly frameType: 'transport.ack'
  readonly deliveryEpoch: string
  readonly ackThrough: number
}
```

初版依赖单 socket 有序传输，只确认连续前缀，不引入任意 selective ACK。若发现 sequence 缺口：

- 不推进 `ackThrough`；
- 记录结构化诊断；
- 请求发送方从当前连续 cursor 重放，或关闭连接后恢复；
- 不跳过缺失 frame 后继续宣称同步。

### 5.5 Error frame

错误至少区分：

- `unsupported-transport-major`：终止，等待升级或明确 v1 fallback；
- `unsupported-adk-profile`：终止，不发送对话数据；
- `unauthorized` / `revoked`：终止，不自动高频重试；
- `invalid-frame` / `integrity-error`：协议错误，终止并告警；
- `resume-rejected`：可恢复，进入 durable replay + Journal reconciliation；
- `over-capacity`：发送方回压或等待，不静默丢 durable 消息；
- `temporary-unavailable`：按 full jitter 重连。

错误不得包含 credential、resume secret 或完整对话 payload。

## 6. 身份和 cursor

必须区分四种身份：

| 身份 | 生命周期 | 用途 |
| --- | --- | --- |
| Worker credential | 注册到撤销/轮换 | 每次物理连接认证 |
| `logicalConnectionId` | 一个 Worker 与 Server 的逻辑连接世代 | 恢复连接级状态 |
| `connectionEpoch` | 单个物理 socket | 隔离旧连接回调和 replacement race |
| `deliveryEpoch` | 单方向 durable sequence 世代 | 防止旧 cursor 被误认成新流位置 |

普通断线或进程重启不改变 `deliveryEpoch`。只有在持久 cursor 无法证明连续性、数据库重建或管理员显式重置时，才创建新的 `deliveryEpoch`。

恢复被拒绝时：

1. 双方不得把对端声明的 cursor 当作权威；
2. 未确认 durable outbox 项保留原 `messageId`；
3. 发送方可在新 `deliveryEpoch` 中为这些项分配新 `directionSeq`；
4. 接收方继续按长期 `messageId` 去重；
5. Session Journal 独立执行 heads/cursor reconciliation；
6. UI 显示连接已恢复但历史仍在同步，不能直接显示 fully synced。

## 7. 连接状态机

### 7.1 Worker 状态

```text
stopped
   │ start
   ▼
connecting ──失败──► backoff
   │ TCP/HTTP upgrade
   ▼
authenticating
   │ upgrade accepted
   ▼
negotiating
   │ hello accepted
   ▼
recovering
   │ cursor/outbox reconciliation started
   ▼
online
   │ transient close
   └──────────────► backoff ──timer──► connecting

任何状态 ──stop/revoked/incompatible──► stopped 或 needs-attention
```

状态语义：

- `connecting`：建立 TCP/TLS/WebSocket；
- `authenticating`：Server 校验 Worker credential；
- `negotiating`：选择 transport、ADK Profile 和 features；
- `recovering`：处理 ACK cursor、outbox replay、capability snapshot 和 Journal heads；
- `online`：允许常规 durable 和 volatile 流量；
- `backoff`：等待 full-jitter delay；
- `needs-attention`：凭据撤销、版本不兼容、持久存储故障等不可通过快速重试解决的问题。

`recovering` 不等于所有 Session Journal 已同步。连接状态和每个 Session 的 cache freshness 分别展示。

### 7.2 Server 连接状态

```text
upgrading → awaiting-hello → recovering → active → closing → closed
```

约束：

- 一个 Worker 同时最多一个 active `connectionEpoch`。
- 新连接通过认证和协商后，才可替换旧物理连接。
- replacement 先原子更新 active epoch，再关闭旧 socket。
- 旧 epoch 的 message、close 和 timeout 回调不得把新连接标为 offline。
- Worker online/offline 投影由 active epoch 生命周期驱动，不由任意 socket close 驱动。

这直接避免“新连接已经建立，旧连接随后 close 又把 Worker 标离线”的竞态。

## 8. 重连策略

使用 full jitter：

```text
ceiling = min(cap, base × 2^attempt)
delay = random(0, ceiling)
```

建议初始配置继续以当前值为起点：

- `base = 500ms`；
- `cap = 30s`；
- TCP/WebSocket handshake timeout `10s`；
- WebSocket ping interval `15s`。

这些值是初始配置，不是未经压测的永久容量承诺。

规则：

- 只有连接稳定运行达到配置的稳定窗口后才重置 attempt；刚 open 即断不能重置为零。
- 多候选 URL 按已配置偏好排序；轮换 URL 不改变 `logicalConnectionId`、`deliveryEpoch` 或 `messageId`。
- 认证失败、撤权、transport major 不兼容不进入快速无限重试。
- Server 建议对同时重连的 Worker 做 admission limit，Worker 使用 jitter 避免惊群。
- WebSocket ping/pong 负责链路 liveness；应用 heartbeat 只提供业务可观测信息，不进入 durable outbox。
- 至少容忍一次调度抖动；具体 missed-pong 阈值通过故障测试确定。

## 9. 持久化模型

Server 与 Worker 使用各自现有 SQLite 数据库。表名可在迁移实现时调整，但语义必须保留。

### 9.1 Peer state

```sql
CREATE TABLE transport_peers (
  peer_id TEXT PRIMARY KEY,
  logical_connection_id TEXT NOT NULL,
  outbound_delivery_epoch TEXT NOT NULL,
  outbound_next_seq INTEGER NOT NULL,
  outbound_acked_through INTEGER NOT NULL,
  inbound_delivery_epoch TEXT NOT NULL,
  inbound_contiguous_through INTEGER NOT NULL,
  selected_transport_major INTEGER,
  selected_transport_minor INTEGER,
  selected_adk_profile TEXT,
  enabled_features_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 9.2 Outbox

```sql
CREATE TABLE transport_outbox (
  peer_id TEXT NOT NULL,
  delivery_epoch TEXT NOT NULL,
  direction_seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  payload_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  expires_at TEXT,
  coalesce_key TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  first_sent_at TEXT,
  last_sent_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(peer_id, delivery_epoch, direction_seq),
  UNIQUE(peer_id, message_id)
);
```

规则：

- 领域写入和 outbox insert 必须在同一事务。
- ACK 后可删除或进入可压缩状态；诊断只保留元数据，不长期复制 payload。
- ACK 删除行、推进水位、清理去重记录必须同一事务；去重索引只屏蔽「仍在 outbox 里等传输确认」的重复项，不得永久屏蔽同一领域身份的重投（见 10.2）。
- `coalesce_key` 只允许替换尚未发送的 snapshot；已进入 inflight 的记录不可原位改 payload。
- durable 队列达到条数或字节配额时，新的可靠写入必须明确失败或回压，不能退化为直接 `ws.send()`。
- 过期项记录 expired disposition，再从发送集合移除；不静默消失。

### 9.3 Inbox

```sql
CREATE TABLE transport_inbox (
  peer_id TEXT NOT NULL,
  delivery_epoch TEXT NOT NULL,
  direction_seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  disposition_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(peer_id, message_id),
  UNIQUE(peer_id, delivery_epoch, direction_seq)
);
```

规则：

- `messageId` 是跨重连和 epoch 重建的长期 transport 去重键。
- 重复消息返回相同 disposition，不重新产生领域副作用。
- inbox 保留时间必须覆盖 outbox 最大重试窗口；不能先清 inbox、后仍允许旧 outbox 重放。
- 清理策略以双方 ACK 和安全保留窗口为依据。

### 9.4 Journal cursor

Session Journal 不复制进无限通用 outbox。Server 另存：

```text
(sessionId, journalEpoch, contiguousThroughSeq, workerHeadSeq, freshness)
```

Worker Journal 仍是持久历史权威。

## 10. 投递分类

| 数据 | 可靠策略 | 领域身份 |
| --- | --- | --- |
| Server→Worker 对话 invocation | durable outbox + transport ACK | `invocationId` |
| Approval/Cancel/Agent command | durable outbox + transport ACK | `invocationId + approvalId` 或命令自身稳定 ID |
| Workspace 管理命令 | durable outbox + transport ACK | `commandId` |
| command receipt / 管理结果 | durable outbox + transport ACK | 原 `commandId` |
| capability/report snapshot | 可合并的 durable snapshot | snapshot revision/coalesce key |
| 非 partial ADK Event | 先写 Worker Journal，再做 Journal cursor 同步 | Event `id` + `sessionSequence` |
| partial delta | volatile | `invocationId`，不承诺重放 |
| heartbeat/presence | volatile | nonce/观测时间 |
| Task review | Server 领域持久化，不由连接 ACK 表达 | review id |

### 10.1 ACK 分层

必须保持以下层次：

```text
transport persisted ACK
        ↓ 只证明接收端可去重地持久接收
command/invocation accepted or rejected
        ↓ 只证明领域入口接受或拒绝
Invocation/Event execution state
        ↓ running / waiting / terminal
Session Journal cursor ACK
        ↓ 只证明 Server 缓存连续保存到某 sequence
Task review
        ↓ 人工业务决定
```

任何一层都不能替代下一层。产品对外只宣称 durable at-least-once delivery + idempotent effects，不宣称分布式 exactly-once。

### 10.2 重投边界与忙循环禁止

传输确认只证明接收端持久接收，**不等于应用层收据**。以下三条是实现必须满足的不变量（历史 P0 缺陷即违反它们：丢收据的 Command 永久停发，或者被无限重发）：

- **允许重投**：只有 transport ACK 而没有应用层收据的 durable 项必须可以重新入队，分配新的 `directionSeq`，保持领域身份（同一 `commandId`）不变，接收方按长期 `messageId` 与领域身份双重去重。
- **收到收据即停发领域重投**：应用层收到该领域身份的收据后不得再次将 Command 入队；但若该 Command 对应的 durable 传输帧尚无 transport ACK，必须保留原帧和去重记录直至收到 ACK，不能删除中间 sequence 留下永久空洞。断线时传输层可能重放此原帧，Worker 以 `messageId` 去重并重发 transport ACK；它不再次执行领域副作用。已获 transport ACK 的帧此前已被原子清理。
- **入队只在有界事件发生**：deliverable 项的重新入队只允许由握手/重连、新领域事件（命令入队、状态变化）或收据触发。纯 ACK 驱动的 flush 只能重放 outbox，不得重新入队，否则同一 Command 会在一条连接上形成 ACK→入队→发送的忙循环。

## 11. Session Journal 恢复

现有 `heads / request / batch / gap` 保留领域职责，并增加 `journalEpoch` 与严格连续性：

```ts
interface JournalHead {
  readonly sessionId: SessionId
  readonly journalEpoch: string
  readonly headSeq: EventSeq
}

interface JournalBatch {
  readonly sessionId: SessionId
  readonly journalEpoch: string
  readonly fromSeq: EventSeq
  readonly throughSeq: EventSeq
  readonly hasMore: boolean
  readonly events: readonly JournalEvent[]
}

interface JournalGap {
  readonly sessionId: SessionId
  readonly requestedFromSeq: EventSeq
  readonly journalEpoch: string
  readonly availableFromSeq: EventSeq | null
  readonly headSeq: EventSeq
  readonly reason: 'epoch-mismatch' | 'history-pruned' | 'missing-event' | 'journal-reset'
}
```

流程：

1. 握手完成后 Worker 分页发送 heads。
2. Server 比较 `(journalEpoch, contiguousThroughSeq, headSeq)`。
3. Server 请求缺失的连续区间。
4. Worker 只返回从 `fromSeq` 开始连续的 batch。
5. Server 在一个事务内按 Event `id` 和 `sessionSequence` 双重去重、写入事件、推进连续 cursor。
6. Server 提交成功后确认 Journal cursor。
7. epoch 不匹配或缺口无法完整取得时返回结构化 `gap`。
8. Server 把 freshness 标记为 incomplete/unrecoverable，不把部分缓存伪装为 synced。

普通 Worker 重启不改变 `journalEpoch`。只有 Journal 被重建、丢失、清理到无法证明连续性或管理员明确重置时才改变。

补传必须同时限制：

- 单 batch Event 数；
- 单 batch 序列化字节数；
- 单 Session 连续发送配额；
- 一轮连接恢复的总读取时间。

调度采用加权公平策略，避免百万事件 Session 饿死控制消息和其他 Session。

## 12. 背压与调度

连接模块维护：

- `maxInflightMessages`；
- `maxInflightBytes`；
- socket `bufferedAmount` 高低水位；
- outbox 总条数与总字节配额；
- 单 frame 最大值；
- 每个 lane 的发送预算。

调度优先级建议：

1. transport control 与 ACK；
2. cancel、approval、stop 等时效性控制；
3. 新 command/invocation；
4. command receipt 与终态通知；
5. Journal catch-up；
6. capability snapshot；
7. volatile partial/presence。

不能仅按严格优先级无限发送，否则低优先级永久饥饿。实现应采用 weighted round-robin 或等价公平调度，并为 control 保留固定容量。

达到 socket 高水位时：

- 暂停从 durable outbox 取新项；
- volatile 数据立即丢弃或合并；
- 已持久 durable 项仍留在 SQLite；
- 超过持续拥塞阈值时关闭物理 socket，通过重连恢复；
- 不删除未 ACK durable 项。

初始数值应通过断网、slow consumer、SQLite busy 和大 Journal 测试确定，不直接照抄第三方默认值。

## 13. 原子性与崩溃边界

### 13.1 发送方

正确顺序：

```text
BEGIN
  写领域事实
  写 transport_outbox，保存固定 messageId 和序列化 payload
COMMIT
wake connection
```

若进程在 commit 后、发送前崩溃，重启后 outbox replay。

### 13.2 接收方

正确顺序：

```text
BEGIN
  查 transport_inbox(messageId)
  若重复，读取原 disposition
  否则应用幂等领域副作用
  写 transport_inbox + disposition
COMMIT
发送 transport ACK
```

若进程在 commit 后、ACK 前崩溃，发送方重发，接收方读取原 disposition，不重复执行。

### 13.3 禁止的顺序

- 收到 frame 后先 ACK，再写数据库；
- 领域记录提交后异步尝试写 outbox；
- 每次重试重新生成 `messageId` 或 `invocationId`；
- 仅用内存 `Set` 去重；
- 把 socket `send()` callback 当作对端持久确认。

## 14. 安全设计

- Worker 只主动出站，不要求开放 Worker 集群控制端口。
- 每个物理连接重新验证 Worker credential、撤销状态和 Server 地址策略。
- resume 信息必须绑定 Worker 身份，不得允许另一个 Worker 使用。
- `logicalConnectionId` 不是 bearer credential；若加入独立 resume secret，该 secret 必须可轮换、不可记录到日志。
- TLS 场景严格校验证书；显式公网访问必须使用 HTTPS/WSS。
- 握手声明的 workerId 不能覆盖认证结果。
- frame schema 在进入领域处理前验证；未知 feature 不启用，未知 durable payload 不 ACK 为成功。
- payload 大小、JSON 深度、数组数量和 Journal batch 都有限制。
- Agent Provider credential、Git credential、模型密钥不进入 transport diagnostics。
- 授权撤销后，即使 cursor 可恢复，也必须拒绝新物理连接。

## 15. 可观测性

`ConnectionSnapshot` 至少包含：

```ts
interface ConnectionSnapshot {
  readonly state: 'stopped' | 'connecting' | 'authenticating' | 'negotiating' | 'recovering' | 'online' | 'backoff' | 'needs-attention'
  readonly selectedUrl: string | null
  readonly connectedAt: Timestamp | null
  readonly lastFrameAt: Timestamp | null
  readonly lastPongAt: Timestamp | null
  readonly reconnectAttempt: number
  readonly nextRetryAt: Timestamp | null
  readonly selectedTransport: string | null
  readonly selectedAdkProfile: string | null
  readonly enabledFeatures: readonly string[]
  readonly connectionEpoch: string | null
  readonly outboundPendingCount: number
  readonly outboundPendingBytes: number
  readonly inflightCount: number
  readonly inflightBytes: number
  readonly oldestPendingAt: Timestamp | null
  readonly lastError: { readonly code: string; readonly at: Timestamp } | null
}
```

日志和指标至少覆盖：

- connect/open/close code/reason；
- URL 轮换和 reconnect delay；
- handshake 选择结果；
- resume accepted/rejected 原因；
- 每方向 ACK cursor 和 lag；
- outbox count/bytes/oldest age；
- inflight count/bytes；
- dropped/coalesced volatile 数量；
- Journal backlog、gap 和 epoch mismatch；
- SQLite busy/full/write error；
- active `connectionEpoch` replacement。

日志只记录 message kind、ID、大小和 cursor，不记录完整聊天内容。

## 16. v2 破坏式替换

用户已明确要求不保留 v1。本次发布采用纯 transport v2，不实现双栈或 fallback。

### 16.1 升级规则

1. Server 和 Worker 必须成对升级；第一帧只能是 `{ frameType: 'transport.hello', ... }`。
2. 所有业务 payload 只能封装在 v2 `data` frame 内；不再接受顶层 `protocolVersion: 1` 消息。
3. 旧 Worker 连接新 Server时收到明确 `unsupported-transport-major` 后关闭；不进入快速重试。
4. 新 Worker 连接旧 Server时进入 `needs-attention` 并提示升级；不得回退或无限重连。
5. transport 与 Wemux ADK Profile 仍独立协商；没有 ADK Profile 交集时拒绝承载对话数据。
6. 管理界面只展示 v2 transport、ADK Profile、恢复状态和 backlog，不保留 legacy 状态。

### 16.2 数据迁移

- SQLite migration 可重入，并在事务中创建 transport 表。
- 现有 pending command 在首次 v2 启动时以原 `commandId` 和稳定 `messageId` 导入 outbox。
- 已接受或终态 command 不重新变成 pending。
- 旧 Worker Journal 保持原 sequence；首次升级生成并持久保存 `journalEpoch`，普通重启不再变化。
- outbox 保存 payload wire version，升级不能用新 schema 猜测旧 payload。

### 16.3 回滚边界

- transport v2 上线后不支持仅回滚一端；Server 与 Worker 必须按兼容发布单元回滚。
- 已使用 v2 创建的领域事实不能因回滚 transport 而丢失。
- v2 transport 表允许旧二进制忽略，但旧二进制不能重新加入已升级集群。

## 17. 实施切片

### R0：合同和故障模型

- 固化本设计、frame schema 草案和状态图。
- 建立 deterministic clock、random 和 socket test adapter。
- 先写 ACK 丢失、commit-before-ACK、旧 socket close、重连惊群等行为测试。

### R1：状态机重构，不改变 v1 语义

- 将 `apps/worker/src/transport/websocket.ts` 的隐式回调状态整理成显式状态机。
- 增加 full jitter、稳定窗口、结构化诊断和正确 shutdown。
- Server Gateway 使用 `connectionEpoch` 防旧连接 close 覆盖新连接。
- 保持现有 v1 message schema，降低后续切片风险。

### R2：纯 v2 握手与版本协商

- 在 `@wemux/wire-protocol` 增加 transport v2 frame schema并删除 v1 envelope。
- Server 和 Worker 只接受 v2。
- 独立协商 transport 和 Wemux ADK Profile。
- 增加 incompatibility 和 feature downgrade 测试。

### R3：Server→Worker durable command

- Server command 创建与 outbox 同事务。
- Worker inbox 与 command record 同事务。
- transport ACK 与现有 `CommandReceipt` 分层。
- 覆盖 ACK 丢失、两端重启和重复投递。

这是首个端到端纵向切片，证明可靠层价值，不先泛化所有消息。

### R4：Worker→Server durable result 和 snapshot

- command receipt、Workspace report 进入 Worker outbox。
- capability 使用 coalesced durable snapshot。
- 建立双方向 cursor、inflight 和容量策略。

### R5：Session Journal epoch 与严格恢复

- 增加 `journalEpoch`。
- heads 分页、batch 数量/字节限制、公平调度。
- gap 结构化，all-or-nothing recovery。
- partial 继续 volatile，不进入通用 outbox。

### R6：运维和发布准备

- 管理 UI 与诊断接口展示 transport 状态和 backlog。
- 完成成对升级、备份、磁盘满、SQLite busy、slow consumer 和 reconnect storm 验证。
- 明确纯 v2 发布单元、旧 Worker 不兼容提示和回滚边界。

## 18. 验收测试

### 18.1 ADK 兼容回归

- 同一 invocation 经 Worker 本地入口和集群入口产生等价 Wemux ADK Profile Event。
- transport 重发不改变 `invocationId`、Event `id`、Content、Actions 或终态。
- partial 丢失不改变非 partial Journal 重放结果。
- Pi、Claude Adapter 测试不需要创建 WebSocket。
- Transport 测试使用固定 ADK payload，无需启动真实 Provider。
- transport v2 升级前后的 ADK Profile 映射往返结果一致。

### 18.2 可靠投递

- 接收端已提交但 ACK 丢失，重投后副作用只出现一次。
- 发送后连接在 ACK 前断开，重连使用同 `messageId`。
- Worker/Server 分别在 pending、inflight、processed-before-ACK 状态重启。
- 新连接替换旧连接后，旧 close 不得标记 Worker offline。
- 错误 epoch、过旧 cursor、未知 logical connection 明确拒绝恢复。
- 授权撤销后持旧 resume 状态重连仍失败。

### 18.3 背压和容量

- slow consumer 使 socket buffer 增长时暂停 outbox dequeue，durable 数据不丢。
- outbox 满载时可靠写入明确失败或回压。
- volatile partial 在压力下可丢弃并有计数。
- 百万 Journal Event 的 Session 不饿死 stop/approval 和其他 Session。
- batch 同时受 Event 数和字节数限制。

### 18.4 版本迁移

- 新 Server 接受旧 Worker并标记 v1 legacy。
- 新 Worker连接旧 Server时只执行一次明确 fallback 或进入 needs-attention。
- transport major 不兼容明确失败。
- ADK Profile 无交集明确失败。
- minor/feature 降级可观察，未声明 feature 不下发。
- SQLite migration 重跑无副作用；升级中断后可继续。

## 19. 明确拒绝

- 不把每个 Session 建成一个 WebSocket。
- 不把 Agent 直接注册为网络节点。
- 不让 Adapter 发送 transport frame。
- 不把 partial token delta 写进 durable outbox。
- 不把完整 Journal 再复制成第二份通用消息日志。
- 不用 transport ACK 替代 `CommandReceipt`、ADK 终态或 Task Review。
- 不因 socket 恢复成功就宣称所有 Session 历史已同步。
- 不宣称 exactly-once。
- 不在没有测量依据时引入 Broker 或多 Server 共识。
- 不允许 durable 队列满载后静默降级为 volatile。

## 20. 完成定义

只有同时满足以下条件，可靠长连接模块才可视为交付：

1. v2 状态机和破坏式替换已实现，v1 代码路径已删除；
2. Server→Worker 与 Worker→Server 至少各有一个 durable 纵向切片；
3. SQLite outbox/inbox/cursor 在崩溃边界测试中不丢消息、不重复副作用；
4. 旧 socket replacement race、断网、重启、slow consumer、磁盘错误有自动化验证；
5. Session Journal epoch/gap 语义不把不完整历史报告为 synced；
6. 本地入口与集群入口的 Wemux ADK Profile 兼容回归通过；
7. 连接诊断不泄露凭据和聊天内容；
8. 文档明确当前支持的 transport、ADK Profile、迁移与残余限制。
