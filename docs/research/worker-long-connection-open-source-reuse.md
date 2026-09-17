# Research: Wemux Lite Worker→Server 单长连接的开源复用选项

> 调研日期：2026-06-27  
> 范围：Node.js、WebSocket、SQLite、Worker 主动出站、单连接多路复用；稳定重连、握手与版本协商、心跳、ACK/重传、去重、离线持久队列、Session Journal cursor 补传。  
> 证据优先级：官方规范、官方文档、官方源码。本报告只提出技术决策，不表示相关能力已经实现。

## Summary

近期最合适的路线不是引入 Socket.IO、Centrifugo、NATS、MQTT broker、Cloudflare Durable Objects 或 Temporal，而是保留现有 `ws + node:sqlite`，在 Wemux 自有 wire protocol 上补一层小而明确的可靠传输状态机。这样最符合仓库的单 Server、轻量自托管、Worker 主动出站、Worker Journal 为历史权威、Wemux ADK Profile 不被第三方传输协议替代等约束。

可以直接借鉴但不直接接入的核心设计是：Socket.IO 的私有恢复 ID 与 offset、Centrifugo 的 `epoch + offset` 和“不能完整恢复就明确失败”、NATS JetStream 的持久 publish ACK、稳定消息 ID 去重、显式 ACK 与 ack floor、MQTT 5 的 session expiry、inflight window 和 QoS 状态机。近期实现应以 SQLite 持久 outbox/inbox、稳定 `messageId`、按方向单调 delivery sequence、累计 ACK、有限 inflight、full-jitter 重连、版本/feature 协商，以及现有 Session Journal `sessionSequence` cursor 补传为主。

## 仓库现状与约束

### 直接证据

1. `packages/wire-protocol/src/envelope.ts` 只有固定的 `PROTOCOL_VERSION = 1` 和 `messageId`，没有 transport major/minor、可接受版本区间、feature bitmap、逻辑连接恢复身份、方向序号或通用传输 ACK。
2. `packages/wire-protocol/src/messages.ts` 已有：
   - Worker/Server `hello`；
   - 应用层 `heartbeat`；
   - `command` 与 `CommandReceipt`；
   - Session Journal 的 `heads / request / batch / gap`；
   - `messageId` envelope。
   这说明仓库已有正确的领域分层起点，但尚未形成完整的可靠传输层。
3. `packages/wire-protocol/src/commands.ts` 明确规定 `accepted` 表示 Worker 已持久记录，不表示工作完成。这与“至少一次投递 + 幂等副作用”一致，不应被 Socket.IO ACK 或 MQTT PUBACK 直接替代。
4. `apps/worker/src/transport/websocket.ts` 当前：
   - 使用 `ws`、Authorization header、1 MiB `maxPayload`、10 秒握手超时；
   - WebSocket ping/pong 与应用 `heartbeat` 并存；
   - 15 秒默认心跳，未收到 pong 就 `terminate()`；
   - 指数退避上限 30 秒，但没有 jitter；
   - 未连接时 `send()` 直接返回；
   - `bufferedAmount > 4 MiB` 时断开，依赖重连及 Journal replay；
   - 没有通用 outbox、inflight、ACK timeout、重传和持久 dedupe。
5. `apps/worker/src/transport/validation.ts` 只接受 protocol v1 的精确 schema。它目前没有实现兼容协商，而且其可接受 command 分支与 `WorkerCommand` 类型并非完全同步，例如类型中的部分 runtime command 没进入验证器。可靠层改造时必须同时解决 schema 单一来源或契约漂移问题。
6. `CONTEXT.md` 的硬约束：
   - 一个 Worker 到一个 Server 是一条可重建的逻辑长连接，所有控制、Workspace、Session 和 Invocation 消息在其中多路复用；
   - 握手要协商 transport major、Wemux ADK Profile 版本及 feature；不兼容 major 必须拒绝；
   - Server 持久化后向 Worker 至少一次投递；`messageId` 只做传输去重与 ACK；Invocation/Event/command 使用各自稳定领域身份；
   - Worker 持久保存 Session Journal，`sessionSequence` 单调递增，Server 用最后连续 cursor 检测缺口并请求补传；partial delta 不进入可靠历史。
7. `docs/product-direction.md` 要求默认保留单 Server、本地 SQLite 和直接通信，不为假设规模预引入 Redis、消息队列、外部数据库或 Kubernetes。
8. `apps/worker/package.json` 当前生产依赖只有 `ws`。引入 broker SDK 或 Socket.IO 会扩大 Worker 安装面，与“必要依赖、轻量部署”目标冲突。

### 研究者判断

现有 `SyncMessage` 已覆盖 Session Journal 补传的领域语义，因此不应把每个 Journal Event 再复制进一个无限通用 transport outbox。更合理的分工是：

- Server→Worker command、非 Journal 管理消息：可靠 outbox + 通用传输 ACK；
- Worker→Server 的管理报告、capability 快照等：可靠 outbox 或“最新快照覆盖”策略；
- Session 持久事件：Journal 本身就是 durable log，以 `sessionSequence` 和 Server cursor 同步；
- partial delta、在线提示、心跳：volatile，允许丢弃，不进入 outbox。

## 决策矩阵

评分：5 最适合，1 最不适合。“直接复用”指作为近期生产依赖接入，而不是阅读或复制算法。

| 方案 | 与现有 Node/ws/SQLite 契合 | 可靠恢复能力 | 保持 Wemux 协议/领域边界 | 轻量自托管 | 运维成本 | 协议迁移风险 | 许可可控性 | 结论 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 保留 `ws`，自建 SQLite 可靠层 | 5 | 4 | 5 | 5 | 5 | 5 | 5 | **近期推荐；直接实现** |
| Socket.IO + connection-state-recovery | 3 | 3 | 3 | 4 | 4 | 2 | 5 | **不整体接入；复制恢复设计** |
| Centrifugo / Centrifuge | 2 | 4 | 3 | 2 | 2 | 2 | 4 | **参考 epoch/offset；不接入服务** |
| NATS JetStream | 2 | 5 | 3 | 1 | 1 | 2 | 5 | **规模或多 Server 后再评估** |
| MQTT.js + Mosquitto | 3 | 4 | 2 | 2 | 2 | 2 | 4 | **成熟但语义错位；参考 QoS** |
| MQTT.js + Aedes | 3 | 3 | 2 | 3 | 3 | 2 | 5 | **可嵌入但持久化组合复杂，不推荐** |
| MQTT.js + EMQX | 2 | 5 | 2 | 1 | 1 | 2 | 2 | **能力过量且许可需逐版本审查** |
| Cloudflare Durable Objects/Hibernation | 1 | 3 | 2 | 1 | 2 | 1 | 1 | **部署模型不兼容，仅参考状态持久化** |
| Temporal | 1 | 5（工作流） | 1 | 1 | 1 | 1 | 5 | **明确反例：不是连接传输层** |
| Automerge | 1 | 4（CRDT 同步） | 1 | 2 | 2 | 1 | 5 | **相关性低，不用于命令投递** |
| Replicache | 1 | 4（客户端状态同步） | 1 | 2 | 2 | 1 | 需核版本 | **相关性低，仅参考 cursor/mutation watermark** |

## Findings

### 1. Socket.IO：可借鉴 CSR，不值得替换现有协议

**Claim:** Socket.IO 自动重连、heartbeat、客户端重试和 connection-state-recovery 完整度较高，但默认投递仍是 at-most-once；官方明确要求应用自行持久化事件、保存 offset 并在重连时补发。 **Sources:** [Delivery guarantees](https://socket.io/docs/v4/delivery-guarantees), [Connection state recovery](https://socket.io/docs/v4/connection-state-recovery), [SessionAwareAdapter 源码](https://github.com/socketio/socket.io/blob/e4d016bd/packages/socket.io-adapter/lib/in-memory-adapter.ts). **Support:** direct evidence. **Confidence:** high.

官方 CSR 的核心机制很适合复制：

- 握手下发不可公开的 private session ID；
- 每个可恢复 packet 附带 offset；
- 断线时保存 session 状态；
- 重连携带 private ID + last processed offset；
- offset 找不到或过期时恢复失败，应用回到完整同步。

但它不适合直接接入：

- Socket.IO 不是原生 WebSocket wire format，普通 WebSocket 客户端不能互通；接入意味着替换双方 framing 和握手。
- CSR 是短时优化，不保证服务重启后恢复；内存 adapter 的 packet/session 会丢失。
- 官方文档明确说恢复不一定成功，仍需应用级重同步。
- ACK callback packet 在官方 `SessionAwareAdapter` 中不会被持久恢复，因为 callback 不可序列化。
- Server→client 持久投递仍需应用数据库。也就是说，即使引入 Socket.IO，Wemux 仍要实现 SQLite outbox、去重和 Journal cursor。
- 多节点 adapter 支持不一致：内存、Redis Streams、MongoDB 支持 CSR，经典 Redis Pub/Sub adapter 不支持；这会把未来扩展与特定 adapter 绑定。

**可复制源码位置：**

- `socketio/socket.io/packages/socket.io-adapter/lib/in-memory-adapter.ts`：`SessionAwareAdapter.persistSession()`、`restoreSession()`、packet offset 注入、过期清理。
- `socketio/socket.io/packages/socket.io/test/connection-state-recovery.ts`：未知 session、过期 offset、middleware 是否重跑、missed packet 顺序等测试案例。
- `socketio/socket.io-redis-streams-adapter/lib/adapter.ts`：用 Redis Stream offset 校验并分页恢复 missed packets。其“必须限制恢复循环，否则生产速度高于消费速度会无限追赶”的 FIXME 对 Wemux 也很重要。

**判断：** Socket.IO 适合当测试清单和算法样本，不适合成为 Wemux Worker→Server 的近期传输依赖。

### 2. Centrifugo/Centrifuge：`epoch + offset` 是最值得复制的恢复模型

**Claim:** Centrifugo 用单调 `offset` 加流身份 `epoch` 判断恢复是否合法；只有同一 epoch 且完整缺口仍在 history 中才返回恢复成功，否则明确 `recovered: false`，不做静默部分恢复。 **Sources:** [Stream history and recovery](https://centrifugal.dev/docs/server/history_and_recovery), [Client protocol](https://centrifugal.dev/docs/transports/client_protocol), [Client SDK specification](https://centrifugal.dev/docs/transports/client_api). **Support:** direct evidence. **Confidence:** high.

这是 Session Journal cursor 最有价值的参考：

- `offset` 是流内单调位置；
- `epoch` 标识当前流世代，避免数据重建后把旧 offset 误认成新流位置；
- 恢复必须同时满足 epoch 相同、缺口完整可取；
- 不完整时返回明确失败，由权威数据库重新加载；
- positioning 在在线状态发现潜在缺口后主动断开，强制重新走恢复；
- history 有数量、TTL 和单次恢复上限，避免无界 catch-up。

对 Wemux 的映射：

- `sessionSequence` 已相当于 offset；
- 建议给 Journal 增加持久的 `journalEpoch` 或等价世代标识。仅在 Journal 被重建、丢失或不可连续验证时改变，不在普通 Worker 重启时改变；
- Server 保存 `(sessionId, journalEpoch, contiguousThroughSeq)`；
- Worker 只在 epoch 匹配且请求区间完整时返回 batch；否则发 `gap`，Server 标记缓存“不完整/不可恢复”，不得把缓存升级为权威；
- catch-up 要分页，有 `limit`、总字节上限和公平调度，避免一个大 Session 阻塞同连接其他流。

为什么不直接接入 Centrifugo：

- 它的中心模型是 channel PUB/SUB 和短期 history；Wemux 是双向命令、receipt、状态机、Journal 权威同步。
- 引入独立 Go 服务、配置、鉴权代理及可能的 Redis/PostgreSQL engine，违背近期单 Server + SQLite。
- 仍需将 Worker command、command receipt、Session Journal、权限和领域幂等映射为 channel/RPC，形成第二套协议。
- 内存 history 重启即失；持久 engine 又增加外部依赖。

**可复制源码/实现位置：**

- `centrifugal/centrifugo` 的 client protocol Protobuf schema：Command/Reply ID、connect、RPC、push、subscribe recovery 字段。
- `centrifugal/centrifuge-js`：full-jitter reconnect、subscription registry、自动 resubscribe、`since: { offset, epoch }`、失败后 `getState` fallback。
- 官方 history/recovery 实现语义：`wasRecovering` 与 `recovered` 分离，不能把“发起过恢复”误当“恢复成功”。

### 3. NATS JetStream：可靠消息语义最完整，但近期引入成本最高

**Claim:** JetStream 提供持久 stream、publish `PubAck`、稳定 `Nats-Msg-Id` 窗口去重、durable consumer cursor、显式 ACK、AckWait 超时重投、MaxDeliver/backoff 和 ack floor。 **Sources:** [Publishing](https://docs.nats.io/learn/jetstream/publishing), [Delivery and acknowledgment](https://docs.nats.io/learn/jetstream/delivery-and-acknowledgment), [Ack responses and redelivery](https://docs.nats.io/learn/jetstream/acknowledgment), [Consumer survives restart](https://docs.nats.io/tutorials/stream-consumer). **Support:** direct evidence. **Confidence:** high.

最值得复制的语义：

1. **持久确认边界：** PubAck 只证明消息已存储，不证明消费者已处理。映射到 Wemux：transport ACK 只证明接收端可靠落盘；`CommandReceipt.accepted` 证明命令被 Worker 持久接收；Invocation 终态另行记录。
2. **稳定 ID 重试：** publish 超时意味着“结果未知”，不能推断未写入。重试必须保留同一 ID。
3. **ack floor：** durable consumer 保存连续确认位置，重连后从该位置继续。
4. **显式 ACK 与 redelivery：** 未 ACK 的消息到期重投；处理器必须幂等。
5. **in-progress 与超时：** 长任务的执行 lease 不等于 transport ACK。Wemux 不应让 transport ACK timeout 覆盖 Agent 执行时长。
6. **有限 inflight：** 严格顺序时可把 `MaxAckPending` 设为 1，但吞吐下降。Wemux 更适合小窗口并依靠 `messageId` 去重和领域内顺序键。

为什么不近期接入：

- 需要运行 NATS Server、配置 JetStream storage、备份、升级、监控和容量。
- Worker 不再是单纯 WebSocket 主动连接 Server，而是连接 broker；Server 的认证、授权、撤销和连接状态要映射到 NATS account/subject/credential。
- subject、stream、consumer、retention 和 dedupe window 会成为新的长期协议与运维合同。
- Journal 与 JetStream 双持久日志会出现权威归属和保留策略冲突。
- 当前产品明确不为假设规模预引入消息队列。

**结论：** JetStream 是未来多 Server、高吞吐或跨服务消息骨干的候选，不是当前 Worker 单连接的最小答案。

### 4. MQTT.js + Aedes/EMQX/Mosquitto：传输可靠性成熟，但领域映射和 broker 运维不划算

**Claim:** MQTT 5 标准具备 keepalive、session expiry、packet identifier、QoS 1/2、inflight 和重传；MQTT.js 提供自动重连、ping、离线发送、incoming/outgoing store；broker 可保存持久 session 和离线消息。 **Sources:** [MQTT 5.0 OASIS Standard](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html), [MQTT.js](https://github.com/mqttjs/MQTT.js), [Mosquitto persistence](https://mosquitto.org/documentation/persistence/sqlite/), [EMQX durable sessions](https://docs.emqx.com/en/emqx/latest/durability/durability_introduction.md), [Aedes](https://github.com/mcollina/aedes). **Support:** direct evidence. **Confidence:** high.

可借鉴：

- session ID/ClientID 必须稳定，session expiry 明确；
- packet ID 只在 inflight 生命周期内唯一，不能代替应用长期 `messageId`；
- QoS 1 是至少一次，上层必须容忍重复；
- QoS 2 状态机成本高，而且“协议层 exactly once”不等于领域副作用 exactly once；
- Receive Maximum/inflight window 是背压的重要组成；
- message expiry 适合过期命令或 presence，不适合永久 Journal；
- persistent session 恢复 subscription 和未完成 QoS 交换。

各实现评价：

- **MQTT.js：** 客户端部分可以直接复用 reconnect、ping、QoS flow，但接入即改变 wire protocol；默认 store 是内存，真正跨进程恢复仍需额外 store。与现有 `ws` 相比并不能省掉领域幂等和 Journal cursor。
- **Aedes：** Node 内嵌方便、MIT，但持久化默认内存；生产持久化、集群通常再引入 LevelDB/MongoDB/Redis 等 adapter。官方文档还特别提示 slow subscriber 若无 drain timeout 可阻塞投递。作为“嵌入式 broker”会把简单点对点连接变成 broker + topic ACL + persistence plugin 组合。
- **Mosquitto：** 成熟、轻量、持久 session 和 SQLite persistence plugin 可用，但需要额外守护进程、配置文件、证书/ACL、备份和端口；Server/Worker 的身份及命令路由要改成 topic 模型。
- **EMQX：** durable session、RocksDB/Raft、多节点恢复能力强，但对单 Server 产品明显过重；不同版本/edition 的许可证及商业功能边界必须逐版本审查。

**判断：** 如果产品未来要支持大量非 Wemux IoT/边缘节点或标准 MQTT 互操作，MQTT 才有足够收益；当前只适合借鉴 QoS 状态机、inflight window 和 session expiry。

### 5. Cloudflare Durable Objects/Hibernation：托管平台能力，不是本项目可复用组件

**Claim:** Durable Objects 可以让入站 WebSocket 在对象休眠时继续保持连接，并用 attachment/SQLite storage 恢复状态；但 hibernation 不支持对象作为出站 WebSocket 客户端，而且部署时连接会断开。 **Sources:** [Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [Hibernation example](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/), [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), [Storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/). **Support:** direct evidence. **Confidence:** high.

与 Wemux 不匹配：

- Wemux 要自托管 Node Server；Durable Objects 是 Cloudflare 专有运行时和计费模型，不是可嵌入 npm 组件。
- Hibernation 只适用于 DO 作为 WebSocket server；Worker→Server 的主动出站连接不能因此休眠。
- code deploy 会断开 WebSocket，仍要实现应用级 reconnect/resume。
- 把每个 Worker 映射为 DO 会改变部署、存储、网络入口和数据主权模型。

可参考的只有两点：连接 attachment 只保存小型可重建元数据，大状态进持久存储；任何内存状态都假设随时丢失并增量持久化。

### 6. Temporal：适合作为未来工作流层，明确不是连接可靠层

**Claim:** Temporal 通过持久 Event History、Task Queue、Worker polling 和 replay 提供 durable execution；它解决长事务和工作流恢复，不解决现有 WebSocket 的 framing、心跳、连接恢复或 Journal cursor。 **Sources:** [Workflow Execution](https://docs.temporal.io/workflow-execution), [Workflow message passing](https://docs.temporal.io/evaluate/features/workflow-message-passing), [How Temporal works](https://docs.temporal.io/encyclopedia/architecture/how-temporal-works). **Support:** direct evidence. **Confidence:** high.

若引入 Temporal：

- 需要 Temporal Server、数据库及 Worker SDK；
- Wemux 的 Worker 概念会与 Temporal Worker 混淆；
- 需要把 Task/Run/Invocation 映射为 Workflow/Activity/Signal/Update；
- 仍然不能替代 Worker 节点与 Server 的能力上报、流式 partial、WebSocket 心跳和本地 Journal 同步。

因此 Temporal 只能在未来复杂跨 Agent 编排、长事务补偿、定时器和审批工作流出现实际需求时，作为上层 workflow engine 独立评估。为单连接可靠性引入它属于架构错层。

### 7. Automerge/Replicache：都是状态同步方案，与命令投递相关性低

**Claim:** Automerge 是 CRDT 文档与 transport-agnostic sync；Replicache 是浏览器本地 KV、mutation push、cookie pull 和 optimistic reconciliation。二者都不是 Worker command queue。 **Sources:** [Automerge concepts](https://automerge.org/docs/reference/concepts/), [Automerge network sync](https://automerge.org/docs/tutorial/network-sync/), [Replicache how it works](https://doc.replicache.dev/concepts/how-it-works), [Replicache push](https://doc.replicache.dev/reference/server-push), [Replicache pull](https://doc.replicache.dev/reference/server-pull). **Support:** direct evidence. **Confidence:** high.

可参考但不引入：

- Automerge 的“传输无关、每文档 sync state、离线变更合并”适用于多人可并发编辑的数据，不适用于有副作用且必须按授权执行一次的 Agent command。把 Workspace/Session 状态 CRDT 化会模糊 Server 权限和 Worker 执行权威。
- Replicache 的 `clientID + sequential mutation id + lastMutationID` 很适合作为去重水位参考；`cookie` 是由 Server 定义、客户端原样返回的 cursor；无效 cookie 时发送完整重建 patch。这些思想可用于管理投影，但 Replicache 面向浏览器数据同步，不能代替 Worker WebSocket transport。

## 推荐的近期最小方案

### A. 保留技术栈

- 继续使用 `ws` 和现有主动出站拓扑。
- Worker 与 Server 都用各自现有 SQLite 数据库保存可靠状态。
- 不新增 Redis、broker、Go 服务或云专有运行时。
- wire protocol 继续由 `@wemux/wire-protocol` 定义，不让 transport envelope 进入 Wemux ADK Profile。

### B. 定义 transport v2 握手，不原地扩充 v1 含义

建议第一帧为明确握手，概念字段如下：

```text
WorkerHello {
  transport: { supportedMajors: [2], preferredMinor: 0 },
  adkProfiles: ["wemux-adk/2"],
  features: ["transport-ack", "journal-epoch", "journal-batch-v1"],
  workerId,
  workerVersion,
  resume: { logicalConnectionId?, workerToServerAckThrough?, serverToWorkerAckThrough? }
}

ServerHello {
  selectedTransport: { major: 2, minor: 0 },
  selectedAdkProfile,
  enabledFeatures,
  logicalConnectionId,
  connectionEpoch,
  resumeAccepted,
  authoritativeAckThroughByDirection
}
```

规则：

1. transport major 不兼容，发送结构化错误后关闭，不能猜测兼容。
2. minor/feature 只启用双方交集；未声明能力不得下发。
3. 每次物理 socket 有新的 `connectionEpoch`；逻辑连接 ID 可跨短暂断线恢复。
4. 恢复失败不等于业务失败，转入 outbox replay + Journal heads reconciliation。
5. 认证在每次物理连接都重做。不要像 Socket.IO 的 `skipMiddlewares` 那样因恢复而跳过撤权检查。

### C. 两方向独立的 SQLite outbox/inbox

建议最小表意模型，不限定最终 SQL 命名：

```text
outbox(peer_id, direction_seq, message_id, kind, payload,
       created_at, expires_at, state, attempt_count, last_sent_at)
inbox(peer_id, message_id, received_at, disposition, receipt_payload)
peer_cursor(peer_id, outbound_acked_through, inbound_contiguous_through,
            logical_connection_id, connection_epoch)
```

关键事务边界：

- **发送端：** 先在同一事务中写入领域记录和 outbox，再允许发送。收到 transport ACK 后删除或标记 compactable。
- **接收端：** 在同一 SQLite 事务中检查 `messageId`、应用幂等副作用或读取既有结果、写 inbox/disposition，然后才能 ACK。
- 重复消息返回相同 ACK/receipt，不重复执行。
- `messageId` 在所有重试和重连中保持不变；重连不得重新生成。
- `direction_seq` 用于连续进度和批量 ACK，不作为领域身份。
- 可使用累计 `ackThrough`，必要时附有限 `gaps`/selective ACK；初版单 socket 有序传输可只支持连续 ACK。
- outbox 设置总条数、总字节数和按 kind 的保留策略；满载时拒绝新的可靠写入或回压，不能静默丢弃。

### D. ACK 分层

必须区分：

1. **transport persisted ACK：** 接收端已持久保存并可去重；
2. **command receipt `accepted | rejected`：** Worker 已持久接受或确定拒绝命令；
3. **execution state/event：** queued/running/completed/failed 等领域事实；
4. **Journal cursor ACK：** Server 已连续保存到某 `sessionSequence`；
5. **Task review：** 人工业务决定。

任何一层都不能替代下一层。不要宣称 exactly-once；目标是 durable at-least-once delivery + idempotent effects。

### E. 重连、心跳和背压

1. 将当前无 jitter 的指数退避改为 **full jitter**：`delay = random(0, min(cap, base * 2^attempt))`；成功稳定一段时间后再重置 attempt，避免刚连上即断造成同步风暴。
2. 保留 WebSocket ping/pong 作为链路 liveness；应用 heartbeat 只承载业务可观测信息，不作为可靠消息写 outbox。
3. 心跳超时至少容忍一个以上周期，并记录 close code、上次 pong、buffered bytes、重连 attempt 和所选 URL，便于诊断。
4. 增加有限 `maxInflightMessages/maxInflightBytes`。达到上限停止从 SQLite outbox 取新消息，不只依赖 `bufferedAmount > 4 MiB` 后粗暴断线。
5. 大 batch 同时限制 event 数和序列化字节数；公平轮询 Session，防止单个 Journal 饿死控制消息。
6. 给可过期 command 使用领域 `expiresAt`；过期项持久记录为 expired，不执行也不无限重传。

### F. Session Journal cursor 补传

在现有 `heads/request/batch/gap` 上演进：

1. Worker 连接后分页发送 heads：`sessionId + journalEpoch + headSeq`。
2. Server 对每个 Session 保存 `contiguousThroughSeq`，比较后请求 `[fromSeq, limit]`。
3. Worker 从本地 Journal 读取连续区间；batch 包含 `fromSeq/throughSeq/hasMore/events`，并保证每个 event 的 `sessionSequence` 连续。
4. Server 在一个 SQLite 事务中插入 event（按 event id 和 sequence 双重去重）、推进连续 cursor，再 ACK cursor。
5. 缺口、epoch 不匹配或历史已清理时返回结构化 `gap`，包括 `availableFromSeq`、`headSeq`、reason；Server 将 freshness 标为 incomplete/unrecoverable。
6. 不发送“能找到的一部分然后假装恢复成功”。这一点直接采用 Centrifugo 的 all-or-nothing recovery 语义。
7. partial delta 不持久、不补传；重连后由持久 Journal snapshot/event 重建 UI。

### G. 近期不做

- 不做多 Server 共识或跨 Server session migration。
- 不为 transport ACK 引入 Redis、JetStream 或 MQTT broker。
- 不承诺 transport-level exactly-once。
- 不把 Worker Journal 复制成 Server 权威日志。
- 不把每个 Session 建独立 WebSocket。

## 建议测试清单

优先把第三方项目的测试思想转成 Wemux 行为测试：

1. ACK 丢失：接收端已提交，发送端重投；副作用只出现一次，返回相同 receipt。
2. 写入成功但连接在 ACK 前断开：重连后同 `messageId` 重投并去重。
3. 进程在“领域写入/outbox 写入”各事务边界崩溃，验证不丢消息、不出现无对应领域记录的幽灵消息。
4. Worker/Server 分别在 pending、inflight、已处理未 ACK 状态重启。
5. 非法/过期 logical connection ID、错误 epoch、过旧 cursor、未知 feature。
6. transport major 不兼容必须拒绝；minor/feature 降级必须可观察。
7. 断网 1 分钟、1 小时、多日；outbox 容量和过期策略明确。
8. reconnect storm：大量 Worker 同时断线，验证 full jitter 和 Server 限流。
9. slow consumer：socket buffer 持续增长，验证暂停读取 outbox、最终断开恢复，不阻塞其他 Worker。
10. 一个 Session 有百万事件、其他 Session 有少量控制消息，验证分页与公平调度。
11. Journal epoch 改变或中间 event 永久缺失，Server 不得报告 fully synced。
12. 重复 `accepted`、终态 event、workspace report 都能幂等。
13. URL 轮换与首选地址恢复期间，logical connection 和消息 ID 不改变。
14. 授权被撤销后重连，即使有 resume token 也必须重新鉴权失败。

## 引入与运维成本、迁移风险

| 选项 | 代码引入成本 | 新运维面 | 数据迁移 | 协议锁定/回滚 | 主要风险 |
| --- | --- | --- | --- | --- | --- |
| 自建 SQLite 可靠层 | 中 | 低 | 新增本地表，可版本化迁移 | 低；v1/v2 可并存 | 自己承担状态机正确性与测试 |
| Socket.IO | 中 | 低至中 | CSR 若要持久仍需数据库 | 高；不兼容原生 ws | 看似省事，实际仍需应用可靠层 |
| Centrifugo | 高 | 中至高 | channel history 与 Journal 映射 | 高 | 双协议、双鉴权、双状态源 |
| NATS JetStream | 高 | 高 | stream/consumer/retention 设计 | 高 | broker 成为强依赖和故障域 |
| MQTT + broker | 高 | 中至高 | topic/session/QoS 状态 | 高 | topic ACL 与领域授权错位 |
| Durable Objects | 极高 | 云平台绑定 | 数据迁入 Cloudflare | 极高 | 失去默认自托管形态 |
| Temporal | 极高 | 极高 | Workflow history/Task Queue | 极高 | 解决错层问题并重塑领域模型 |
| Automerge/Replicache | 极高 | 中 | 数据模型整体改写 | 极高 | 把命令副作用误建模为状态合并 |

### 协议迁移建议

- 不在 v1 envelope 中悄悄新增改变可靠语义的可选字段，然后假设旧端安全忽略。
- Server 在过渡期同时接受 v1/v2：v1 保持现状但标记 legacy/unreliable；v2 才启用 ACK/outbox/resume。
- Worker upgrade 顺序优先支持“新 Server 接旧 Worker”和“新 Worker 连旧 Server时明确失败或回退”，不能无限 reconnect。
- SQLite schema migration 要可重入；发送队列中的 payload 必须保存其 wire version，升级后不能用新 encoder 误解旧 payload。
- feature negotiation 记录到连接诊断与审计，方便定位“类型存在但对端未声明”的问题。

## 许可证注意事项

以下是工程筛选，不是法律意见；发布前应锁定准确版本并保留 LICENSE/NOTICE/SBOM。

| 项目 | 许可证/形态 | 注意事项 |
| --- | --- | --- |
| Socket.IO | MIT | 可复制或修改源码，但要保留版权与许可文本；复制算法通常比引入整套依赖更合适。 |
| Centrifugo OSS | Apache-2.0 | 保留 LICENSE/NOTICE，注意 Apache-2.0 专利条款；不要把 Centrifugo PRO 文档中的商业功能误认为 OSS。 |
| centrifuge-js | MIT | 可参考 reconnect/recovery；若复制实质代码需保留许可。 |
| NATS Server / JetStream | Apache-2.0 | NOTICE、专利条款；客户端库也需按各自仓库确认。 |
| MQTT 标准 | OASIS 标准文本 | 实现协议不等于复制规范文本；引用规范时保留来源。 |
| MQTT.js | MIT | 引入或复制均需保留许可。 |
| Aedes | MIT | persistence adapter 可能是独立包，必须逐包核许可证。 |
| Eclipse Mosquitto | EPL-2.0 / EDL-1.0 组件边界 | 动态部署独立 broker 与修改/再分发源码的义务不同；SQLite persistence plugin 也应单独核对。 |
| EMQX | **逐版本/edition 核验** | 社区版、企业版及近年版本的授权边界可能变化，不能笼统写成 Apache/MIT；锁版本前需法务复核 LICENSE 和附加使用限制。 |
| Cloudflare Durable Objects | 托管专有服务 | 文档示例许可不等于运行时开源；主要风险是平台条款、数据位置、计费和供应商锁定。 |
| Temporal Server | MIT | 许可宽松，但依赖、部署和运维成本远高于许可成本。 |
| Automerge | MIT | 算法/源码可参考，仍需保留许可；其 CRDT 数据模型不适合本问题。 |
| Replicache | **锁版本核验** | 官方文档显示 license key 已弃用，但这不自动证明所有版本/组件均采用同一开源许可证；若只借鉴 watermark/cookie 思路则无须引入。 |

尤其要区分：

- **借鉴公开协议思想**：如 epoch/offset、ack floor、full jitter，通常不需要复制源码；
- **复制实质源码/测试**：必须保留原许可证和版权声明，并在第三方清单中记录；
- **运行独立服务**：仍受其许可证、商标、容器镜像和商业 edition 条款约束；
- **托管 API**：受服务条款约束，不因示例代码开源而成为开源组件。

## 最终建议

### 推荐决策

1. **近期采用：** 原生 `ws + SQLite reliable transport v2`。
2. **直接借鉴：**
   - Socket.IO：private resume ID、offset、恢复失败 fallback、CSR 测试；
   - Centrifugo：`epoch + offset`、完整恢复或明确失败、positioning；
   - JetStream：persist-before-ACK、稳定 ID 去重、ack floor、有限 inflight、重投；
   - MQTT：session expiry、QoS 1 状态机、packet/inflight 生命周期；
   - Replicache：顺序 mutation watermark 与无效 cursor 时完整重建。
3. **暂不引入：** Socket.IO runtime、Centrifugo、NATS JetStream、MQTT broker、Cloudflare Durable Objects、Temporal、Automerge、Replicache。
4. **重新评估触发条件：**
   - 单 Server SQLite 已测得成为吞吐或恢复瓶颈；
   - 需要多 Server HA、跨服务 durable messaging 或大规模 fan-out；
   - 运维团队明确接受独立 broker、备份与监控；
   - 有标准 MQTT 互操作需求，而非只服务 Wemux Worker。

### 决策理由

该方案不是“重复造一个消息队列”，而是在已经不可避免的领域可靠性边界内实现最小状态机。所有候选组件都无法同时满足：保持 Wemux wire/ADK 边界、Worker Journal 权威、单 Server SQLite、主动出站、无额外服务、低迁移风险。引入它们仍然需要应用层幂等和 Journal reconciliation，却会额外增加协议、部署和状态源。因此近期最优解是复制经过验证的算法，而不是复制它们的运行时架构。

## Contradictions

1. **“Socket.IO 有 connection-state-recovery”与“默认 at-most-once”并不矛盾。** CSR 只覆盖有限时间、adapter 可恢复的 missed packets；官方 delivery guarantees 仍明确要求应用自行实现持久化与 offset 恢复。
2. **MQTT QoS 2 常被称为 exactly once，但不能据此宣称业务副作用 exactly once。** 它只约束 MQTT 协议交换和上层交付；应用在数据库事务、崩溃边界和外部 Agent 调用上仍要幂等。
3. **JetStream 文档有“exactly once”相关表述，但其组成仍是 publish dedupe window + confirmed ACK。** 超出 dedupe window、外部副作用或错误的 ack 时机仍需应用设计；本报告坚持对 Wemux 使用“至少一次 + 幂等”。
4. **Centrifugo recovery 可使用持久 engine，但其 history 设计仍是有界恢复窗口，不自动成为业务权威日志。** Wemux Journal 不能被其 history 替代。

## Missing evidence

- 未对候选项目每个目标版本做完整依赖树许可证扫描；尤其 EMQX、Mosquitto plugin、Replicache 应在锁版本时复核。
- 未做本仓库 Server 端 WebSocket handler、SQLite schema 和 Journal repository 的逐文件审计，因此表结构与迁移工作量是架构级估计，不是精确开发排期。
- 未进行断网、进程崩溃、磁盘满、SQLite busy、百万事件 catch-up 的实测 benchmark。任何队列上限、batch 大小、ACK timeout 都应通过故障注入确定，不应直接照抄第三方默认值。
- 未验证第三方源码 HEAD 与未来发布版本完全一致；报告中的源码路径应在锁定 commit 后固定链接。

## Sources

### Kept

- [Socket.IO Delivery guarantees](https://socket.io/docs/v4/delivery-guarantees) — 官方明确默认投递语义及应用级补偿方式。
- [Socket.IO Connection state recovery](https://socket.io/docs/v4/connection-state-recovery) — private session ID、offset、adapter 支持矩阵。
- [Socket.IO SessionAwareAdapter source](https://github.com/socketio/socket.io/blob/e4d016bd/packages/socket.io-adapter/lib/in-memory-adapter.ts) — 可直接审阅恢复算法。
- [Socket.IO CSR tests](https://github.com/socketio/socket.io/blob/e4d016bd/packages/socket.io/test/connection-state-recovery.ts) — 故障与兼容测试样本。
- [Centrifugo stream history and recovery](https://centrifugal.dev/docs/server/history_and_recovery) — epoch/offset、all-or-nothing recovery、positioning。
- [Centrifugo client protocol](https://centrifugal.dev/docs/transports/client_protocol) — Command/Reply、多路复用、恢复 framing。
- [Centrifugo client API](https://centrifugal.dev/docs/transports/client_api) — full-jitter reconnect、getState fallback。
- [NATS JetStream publishing](https://docs.nats.io/learn/jetstream/publishing) — PubAck 与 `Nats-Msg-Id` 去重。
- [NATS delivery and acknowledgment](https://docs.nats.io/learn/jetstream/delivery-and-acknowledgment) — durable cursor、ack floor、redelivery。
- [NATS ack responses](https://docs.nats.io/learn/jetstream/acknowledgment) — ack/nak/term/in-progress、AckWait、MaxDeliver。
- [MQTT 5.0 OASIS Standard](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html) — QoS、packet ID、session expiry 的规范来源。
- [MQTT.js](https://github.com/mqttjs/MQTT.js) — Node 客户端 reconnect、store、QoS 实现入口。
- [Aedes](https://github.com/mcollina/aedes) — Node broker、persistence 与 backpressure 约束。
- [Mosquitto SQLite persistence](https://mosquitto.org/documentation/persistence/sqlite/) — broker 持久化实现与运维含义。
- [EMQX durable sessions](https://docs.emqx.com/en/emqx/latest/durability/durability_introduction.md) — durable session、iterator 和磁盘/集群成本。
- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) — hibernation 能力与限制。
- [Temporal architecture](https://docs.temporal.io/encyclopedia/architecture/how-temporal-works) — 证明其是 durable workflow，而非连接层。
- [Automerge concepts](https://automerge.org/docs/reference/concepts/) — CRDT/sync 的真实适用边界。
- [Replicache push](https://doc.replicache.dev/reference/server-push) — mutation ID、lastMutationID 与事务要求。
- [Replicache pull](https://doc.replicache.dev/reference/server-pull) — cookie cursor 和全量 fallback。

### Rejected/deprioritized

- 第三方博客和“最佳 WebSocket 库”对比：缺少精确投递语义和源码证据。
- 云厂商营销 benchmark：与单 Server Node/SQLite 的实际约束不一致。
- 未标版本的 npm 下载量或 GitHub star：不能证明协议适配性、可靠性或运维成本。
- 非官方 DeepWiki/摘要：只用于发现源码位置，不作为关键结论的最终证据。

## Next steps

1. 继续审计 Server 端连接 handler、command persistence、Journal repository 和 SQLite migration，形成 transport v2 状态机与精确表结构设计。
2. 先写故障模型和可执行测试，再定 ACK timeout、inflight window、batch 字节数和 outbox 配额。
3. 为 wire v2 写兼容矩阵和逐帧状态图，并明确 v1 退役计划。
4. 在锁定任何第三方版本前生成 SBOM 并完成许可证复核；当前建议无需新增运行时依赖。
