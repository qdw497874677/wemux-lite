# 会话存储策略与可迁移性架构(Session Storage Strategy)

状态:草案 v2(代码库核查后)
日期:2026-09-28
关联:

- `docs/design/worker-web-workbench.md`(双宿主与独立 Worker 承诺)
- `docs/design/m2-dual-host-contract.md`(双宿主运行时合同)
- `docs/design/node-resource-distribution-architecture.md`(R1-R3)
- `docs/design/feature-suite-approvals-routines-architecture.md`(七件套与跨实体投影)
- `docs/design/worker-reliable-connection.md`(可靠连接、领域身份与应用层收据)

## 1. 长远目标与不变承诺

**Worker 节点最终只提供计算与 harness 执行;会话作为一等公民资源,其存储位置是部署者可选的策略,而不是架构的宿命。**

对照 k8s 的心智模型:

| k8s 概念 | Wemux 对应 | 说明 |
|---|---|---|
| Node | Worker | 计算单元 |
| Pod/harness | Agent 进程与工具执行网关 | 可重建的执行面,不等于当前已无状态 |
| PV / StatefulSet | 会话存储卷 | 可备份、可校验、按能力迁移的状态 |
| etcd | Server 控制面 | 保存元数据与投影;是否保存完整会话事实由策略决定 |
| CSI 驱动 | 会话存储策略 | `local` / `replicated` / `central` 三档 |

以下承诺不因存储模式改变:

1. **双宿主不破坏**:`local-worker` 宿主未加入集群时仍可创建和继续本地会话,不要求伪造 Team、Project 或集群 Worker 身份。
2. **Worker 本地写不被偷换**:`local` 与 `replicated` 的会话执行事实先在 Worker 事务提交;Server 投影不得反向成为执行权威。
3. **投影聚合不被偷换**:Approvals、WhatNeedsMe、Timeline 等继续聚合来源事实,不因镜像存在而获得来源生命周期所有权。
4. **三档是用户承诺,不是三个同时交付的实现**:`local` 是现状基线,`replicated` 是近期目标,`central` 必须通过 checkpoint 和在线语义门槛后才可对外承诺。

## 2. 代码库现状核查

### 2.1 Journal 从 Worker 到 Server 的真实链路

当前链路已经传输完整的 `JournalEvent`,不是采样日志:

1. Worker 的 `SqliteWorkerStore` 将事件按 `(session_id, seq)` 写入本地 `journal`,读取接口返回连续页与 `throughSeq`(`apps/worker/src/storage/sqlite-store.ts:194-224`)。
2. `WorkerRuntime` 连接后先发送各会话 head;Server 请求缺口时,Worker 使用现有 `sync` 消息返回 `batch` 或 `gap`;运行中还按页推进已发送水位(`apps/worker/src/application/runtime.ts:87-112`,`apps/worker/src/application/runtime.ts:451-459`)。
3. Worker 应用消息进入可靠传输的 `journal` lane,持久化于 transport outbox;`TransportStore` 从同一 outbox 行重放时保留原 `messageId`、`directionSeq` 与 payload(`apps/worker/src/transport/transport-store.ts:76-100`)。
4. Server 的 Worker WebSocket gateway 接收 `sync/head|batch|gap`,由 `WorkerService` 校验会话归属并写入 cache;gateway 不是 Journal 领域存储本身(`apps/server/src/worker-ws/gateway.ts:79-119`,`apps/server/src/application/worker-service.ts:248-277`)。
5. Server cache 的 SQLite 实现把事件持久化到 `events(session_id,seq,data)`,并维护 `SessionCacheState.contiguousSeq/workerLastSeq/status`;`applyEvents` 要求从当前连续水位之后追加(`apps/server/src/storage/sqlite/store.ts:586-616`,`packages/server-domain/src/projections.ts:31-48`)。
6. 七件套中的审批聚合当前通过 `ProjectionService` 读取 `store.cache.readEvents(...)` 与 freshness,筛选 `approval.requested/resolved` 等事件,不是读取独立会话镜像表(`apps/server/src/application/projection-service.ts:35-125`)。

因此,现状准确名称应是**持久化投影 cache**,而不是“仅采样聚合”。它与可恢复的权威镜像仍有以下差距:

- cache 的合同目标是投影 freshness 与缺口修复,没有声明“可完整导出并恢复 Worker 会话”的耐久性、保留期和恢复 SLO;
- 只证明 `JournalEvent` 连续,尚未覆盖 Native Session、队列、未完成 Turn、checkpoint、运行时能力快照、工具侧状态和 Workspace 引用;
- 没有独立的镜像 manifest、整段校验、加密元数据、版本兼容与恢复完成标记;
- Worker 的 `sent` 水位是进程内状态,重连依靠 heads/cache 水位重新协商,不能直接当作长期 backfill 作业状态;
- `gap` 当前表示范围不可用,尚无“镜像永久不完整”后的治理状态和补救流程。

### 2.2 wire-protocol 与 transport outbox 能否复用

现有应用协议已经有:

- Worker → Server:`sync` 的 `head`、`batch`、`gap`;
- Server → Worker:`sync` 范围请求;
- 传输层 envelope:`messageId`、`directionSeq`、`lane`、`payload`;
- `journal` lane 的配额与慢消费者保护。

证据见 `packages/wire-protocol/src/messages.ts:68-124`,`packages/wire-protocol/src/transport-v2.ts:5-78`。

**裁定:近期不新增名为 `journal.sync` 的平行顶层帧。** P1 先扩展现有 `sync` 合同或增加其版本化字段,例如 mirror generation、chunk checksum、manifest 与 backfill receipt。另造 `journal.sync` 会与已有 `sync batch/gap` 重叠,形成两套追赶状态机。

transport envelope 与 outbox 可以复用“断线重放、传输排序、ACK 后删除”的机制,但现有 Journal cursor 设计明确禁止把无限历史复制进通用 outbox(`docs/design/worker-reliable-connection.md` §9.4)。replicated backfill 只能让**有界的单个在途 chunk**进入 outbox,receipt 后再枚举下一块;不能预先把全部历史事件或 chunks 入队。传输 ACK 也不能当成镜像已提交的业务证明。必须增加稳定的镜像领域身份和应用层收据,例如:

```ts
interface SessionMirrorChunkIdentity {
  readonly sessionId: SessionId
  readonly generation: string
  readonly fromSeq: EventSeq
  readonly throughSeq: EventSeq
  readonly plaintextSha256: string
}
```

同一 chunk 在同一 outbox 行的网络重放保持 `messageId/directionSeq`;若因只有 transport ACK、没有应用层 receipt 而重新发行,则允许产生新的 `messageId/directionSeq`,但上述镜像领域身份必须保持不变。Server 在镜像事务提交后返回应用层 receipt;Worker 收到 receipt 后才推进 backfill checkpoint。纯 transport ACK 只触发 outbox 重放,不得重新枚举 Journal 并入队。该约束直接遵守 `docs/design/worker-reliable-connection.md` §9.2、§9.4、§10.1、§10.2 以及仓库关于“收到收据即丢弃待发行”的不变量。

### 2.3 Session 增加 storageMode 的真实侵入面

策略分为两层:

- **部署策略**:Worker 或集群为新会话提供默认模式与可用能力;
- **会话事实**:每个 Session 保存创建时解析出的 `storageMode`,后续变更必须走显式迁移,不能因 Worker 默认值变化而静默改变。

`storageMode` 不是只改一个领域类型。至少涉及:

| 层 | 现有事实 | P0 侵入面 |
|---|---|---|
| Server 领域 | `Session` 定义在 `packages/server-domain/src/resources.ts:85-107`,整体 JSON 存于 `records(kind='session')` | 增加兼容旧记录的字段与校验;创建、fork/reuse、序列化和迁移必须明确继承规则 |
| Worker 执行 | Worker 使用 `SessionExecution`,本地 `documents(bucket='sessions')` 保存 binding、runtime、`nativeSession`(`apps/worker/src/domain/session-execution.ts:14-23`,`apps/worker/src/storage/sqlite-store.ts:274-312`) | 集群会话保存 effective mode 与 mirror/checkpoint 状态;独立本地会话固定为 `local`,除非以后显式发布到集群 |
| Command/wire | `session.create` 携带 Session 资源;capability 帧当前只报告 Agent/terminal 能力 | 创建命令传递 effective mode;Worker capability 增加 mirror/checkpoint/export 能力版本,不能用一个布尔值掩盖不同恢复等级 |
| Server 应用 | `ServerService` 创建、fork/reuse、更新 Session;Task/Run 可创建或复用 Session | 幂等 fingerprint、reuse 资格、fork 继承、迁移 CAS 与审计均需纳入模式 |
| Web 合同 | `SessionDTO`、`SessionResourceDTO`、创建请求与多个宿主映射当前无该字段 | 列表/详情展示模式与健康状态;首版不允许浏览器凭 Worker 能力自行猜默认模式 |
| 双宿主 | 本地 API 使用宿主中立 Session Surface,不伪造集群字段 | `local-worker` 返回 `local`;集群 DTO 才展示 mirror/central freshness 与管理动作 |

为兼容历史记录,缺失 `storageMode` 必须按 `local` 读取;写回只能发生在明确迁移或正常资源更新中,不得为了读旧库进行全表隐式重写。

### 2.4 enc:v2 能否直接用于镜像加密

`packages/connector/src/secret-codec.ts:1-93` 的 `enc:v2` 已提供有价值的安全基线:

- AES-256-GCM;
- 每记录随机 16 字节 salt 与 12 字节 IV;
- 固定 scrypt 参数;
- `keyId` 与多 key 读旧写新;
- owner、credential、authType、revision 绑定到 GCM AAD;
- 非 `enc:v2` 输入 fail closed,旧格式只允许显式迁移。

但它当前是**连接器小型 Secret 的 codec**,上下文与存储约束围绕 credential,并不适合把每个大 Journal chunk 或 checkpoint 直接当作 connector secret 加密。每块执行 scrypt 也会放大大规模 backfill 的 CPU 成本。

**裁定:复用 enc:v2 的 keyring、keyId 轮换、随机 nonce、AAD 与 fail-closed 规则,不直接复用其 connector owner schema 或逐事件密文格式。** 镜像应采用 envelope encryption:

1. 每个 Session mirror generation 生成 DEK;
2. Journal chunk/checkpoint 用 DEK 做 AEAD,nonce 唯一,AAD 至少绑定 `sessionId/generation/range/formatVersion/plaintextSha256`;
3. DEK 由 Server mirror keyring 包装,记录 `keyId`;轮换优先重包 DEK,不强制重加密全部历史;
4. 另建 session-storage crypto port,可在内部复用 SecretCodec 的密钥解析与兼容原则,但不得把会话正文写入 connector credential 表。

## 3. 存储策略模型

### 3.1 mode=local(默认,向后兼容)

- 会话事实只以 Worker 本地 `worker.sqlite`、Agent Native Session 与关联工作集为恢复来源;
- 集群会话的 Journal 仍按现有协议上行到 Server projection cache,用于实时 UI、审批和聚合查询;
- Server 不承诺从 cache 恢复完整会话;
- Worker 独立宿主创建的会话始终从 `local` 开始,加入或退出集群不会静默发布、复制或删除它们。

适用:隐私优先、单机自用、节点稳定。

### 3.2 mode=replicated(推荐档,增量实现)

- Worker 仍是写权威,每次领域提交先落本地;
- Server 保存完整、有序、可校验、加密且有保留合同的权威镜像;
- 镜像至少包含 Journal manifest 与恢复所需 checkpoint;仅有 Journal 时只能称“完整历史镜像”,不能声称可恢复 Native Session;
- Server 可提供授权后的只读会话视图与灾备状态;写命令仍路由到当前 Session 绑定 Worker;
- Worker 离线时,只读镜像可用并明确 freshness;不得把离线镜像展示成实时执行状态。

适用:需要灾备和跨节点可见性,同时保留本地写性能与离线执行能力。

### 3.3 mode=central(远期档)

- Server 是会话持久状态的权威;Worker 只持有租约内 working set;
- Worker 获得带 generation/fencing token 的执行租约,不得由两个 Worker 同时推进同一 Session;
- turn 开始前必须取得所需 checkpoint,turn 终态只有在 Journal 与 checkpoint 被 Server 原子接受后才能对外确认持久完成;
- 任意节点接任取决于目标 Agent Adapter、模型、Workspace Placement、凭证引用和 checkpoint capability 均兼容,不是仅复制消息数组即可实现。

适用:节点池化调度、高可用与集中治理。

central 模式不继承 `replicated` 的完整离线承诺。集群控制面不可达时:

- 不接纳新的 central turn;
- 已持租约的进行中 turn 按冻结策略继续到安全边界或停止,但未获 Server commit receipt 前不得宣称已持久完成;
- Worker 本地独立 `local` 会话继续可用;
- 登录 Worker Web 不自动取得 central 集群会话权限,也不得用 working set 绕过 Server 授权。

这与双宿主设计一致:双宿主保证 Worker 独立能力,不保证 Server 权威会话在控制面离线时仍可写。

### 3.4 模式迁移语义

模式允许显式转换,但不是无条件“单向递进可回退”:

| 转换 | 前置条件 | 完成点 |
|---|---|---|
| `local → replicated` | Session 属于集群且获得发布授权;Worker 仍持有完整本地事实 | backfill manifest 校验通过,Server 返回 mirror-complete receipt |
| `replicated → local` | 无 central 租约;部署者接受停止后续镜像 | Worker 记录降级 revision,Server 保留或按保留策略归档既有镜像 |
| `replicated → central` | checkpoint 格式与 Adapter capability 兼容;Server 存储健康;会话排空 | final checkpoint 提交成功,Server 发新 generation 与权威切换审计 |
| `central → replicated` | 选定目标 Worker,Workspace 与 Agent 可用;完整事实已下放并校验 | 目标 Worker durable import 成功并取得唯一写租约 |
| 任意跨 Worker 迁移 | 排空、fencing、目标能力与凭证引用重新解析 | Server CAS 更新 binding,源租约失效,目标首个读取校验成功 |

转换失败保持原权威不变。不得在“部分 backfill”或“checkpoint 不可恢复”时提前修改 `storageMode`。

## 4. 关键原语

### 4.1 权威镜像

镜像不是第二套 Session 状态机。建议由以下模块承担单一职责:

- `SessionMirrorSource`(Worker):枚举 manifest、按范围读取 chunk、保存应用层 receipt 水位;
- `SessionMirrorRepository`(Server):校验、解密/加密边界、幂等提交、完整性与保留;
- `SessionMirrorCoordinator`(Server):根据 heads、manifest、配额和连接状态调度 backfill;
- 现有 projection cache:继续服务低延迟查询;可从镜像派生,但其表与保留策略不等同于镜像权威。

镜像状态至少包含:

`disabled | backfilling | current | lagging | gap | corrupt | key_unavailable | source_unavailable | archived`

UI 必须同时显示 `throughSeq`、Worker head、字节进度、最近校验时间和失败原因。

### 4.2 Checkpoint

checkpoint 只能在**turn 安全边界**生成。其格式至少版本化记录:

- 平台 Journal 水位与内容摘要;
- Agent Adapter kind/version 与模型标识;
- Native Session 恢复引用或可移植状态;
- capability snapshot 的非秘密部分;
- 未完成审批、队列和 Turn 的显式处理结果;
- Workspace 引用、资源 revision 与凭证 locator,不含凭证明文;
- 格式版本、生成端版本、校验和与兼容范围。

当前 Pi Adapter 仅从 RPC 事件取得 `native-session` id,后续以 `--session <id>` 恢复(`apps/worker/src/agents/pi-runtime-session-adapter.ts:134-137`,`apps/worker/src/agents/pi-runtime-session-adapter.ts:219-240`)。它没有“导入任意消息历史并重建等价 Native Session”的接口。Journal 中也含平台投影和工具事件,不能安全地全部重放给模型,否则可能重复工具副作用。

因此 checkpoint capability 必须分级,不能只上报 `supportsCheckpoint: true`:

- `native-resume-local`:仅能在仍拥有原 Native Session 文件的同一运行时恢复;
- `native-export-import`:Agent Adapter 能导出并在另一节点导入等价状态;
- `semantic-rebuild`:只以经裁剪的对话上下文创建新 Native Session,必须标注非位级等价且禁止重放副作用;
- `unsupported`。

Pi 在完成真实跨目录、跨 Worker 探针前只能按 `native-resume-local` 处理。`central` 不得以未经验证的 `semantic-rebuild` 冒充无缝迁移。

### 4.3 Export/Import

`session export` 输出版本化单文件容器,包含:

- manifest;
- 加密 Journal chunks;
- 可用 checkpoint;
- 资源与 Workspace 引用清单;
- 校验和、来源与 redaction 声明;
- 不包含 BYOK Secret、登录 token、transport credential 或未授权文件正文。

`session import` 必须先进入 staging,完成格式、hash、权限、Agent capability、Workspace、资源 revision 与凭证 locator 检查后再原子激活。导入不得覆盖已有 Session ID,除非走带 CAS 与审计的恢复操作。

### 4.4 Placement Migration

操作顺序固定为:

1. `draining`:拒绝新 turn,处理或显式取消队列;
2. 等待活跃 turn 到安全边界;
3. 生成 final checkpoint 与 manifest;
4. Server/目标 Worker staging import 并验证;
5. 取得新 generation/fencing token;
6. Server CAS 更新 Session binding;
7. 目标 Worker首读与必要的 Native Session resume 探针成功;
8. 源 Worker归档 working set;删除另走保留期与审计。

复用 Task/Run 的 requestId、幂等与 CAS 约定,但迁移拥有独立领域身份,不能复用 transport `messageId` 充当业务幂等键。

## 5. 安全、隐私与容量边界

1. 镜像内容默认视为高敏感数据;静态加密、传输加密、授权、审计、备份和删除必须覆盖正文,不能只保护 manifest。
2. 集群通道使用既有 WSS/HTTPS 部署边界;开发环境允许 HTTP 不等于生产镜像可明文公网传输。
3. BYOK 凭证不随会话迁移;只迁移 locator。目标 Worker 必须重新解析并报告 `available/unavailable/invalid`,明文不写 Journal、checkpoint、report 或日志。
4. Server 只读镜像查询继续执行 A3 的 Project/Session/Worker 权限求交;拥有镜像密文不等于应用层可读取。
5. 删除需要区分 Session 逻辑删除、镜像保留、备份到期和加密擦除;在开放问题冻结前不得宣传“删除即不可恢复”。
6. backfill 使用独立低优先级预算,不得挤占 command、receipt、活跃 Journal 与审批流量。建议按 Worker 和 Server 同时设置 bytes/s、最大在途 chunk、每日回填量与磁盘高水位。
7. chunk 大小、压缩算法与上限必须由真实数据测量冻结;压缩应在加密前完成,解压设置输出上限以防压缩炸弹。

## 6. 与既有设计的关系

### 6.1 R1-R3 资源分发

`docs/design/node-resource-distribution-architecture.md` 的 R1-R3 解决 Skill、Agent runtime、Preset、模型供应商配置与 credential locator 的分发。它们回答“目标 Worker 是否具备恢复该会话的执行材料”,不拥有 Session Journal 或 checkpoint。

- R1 的 Skill revision 与静态资源 manifest 可被 checkpoint 引用;
- R2 的 runtime/Preset capability 与受控重启状态为 checkpoint capability 探测提供载体;
- R3 的 provider config 与 `worker-credential` locator 让迁移后重新解析凭证成为可能;
- Session mirror 不得伪装成 `ResourceBinding`,因为其生命周期、保留、权限和写权威均不同。

### 6.2 七件套投影

“七件套”指 G48-G54 七项产品能力,不是“七张投影表”或“七类会话投影”。其中 Approvals、WhatNeedsMe、Timeline 依赖 F1 跨实体只读投影,且明确不拥有来源事实(`docs/design/feature-suite-approvals-routines-architecture.md:28-63`,`docs/design/feature-suite-approvals-routines-architecture.md:746-750`)。

replicated 镜像可改善 Worker Journal 来源的 completeness 与离线只读能力,但:

- F1 仍读取安全投影 DTO,不直接暴露完整镜像;
- 决策写入仍路由到权威来源并重新校验;
- Timeline 仍不展示完整聊天、tool input/output 或 Secret;
- 镜像与 projection cache 可以共享解码器,不能“合一”为一个既负责恢复又负责跨域查询的浅层模块。

### 6.3 双宿主

双宿主设计在 `docs/design/worker-web-workbench.md` 和 `docs/design/m2-dual-host-contract.md` 中以 M1/M2、W1-W3、`local-worker|cluster` host contract 表达。仓库中的 **G47 是钉钉 Stream Channel 切片,不是双宿主编号**(`docs/design/connector-module-contracts.md:818`)。本文不再使用“G47 双宿主”这一错误交叉引用。

本设计遵守以下边界:

- 一个 Session 只有一个持久队列、Journal 和 Native Session 执行所有者;
- 独立本地会话不因 Worker 加入集群而自动上传;
- local-control 与 cluster host 可复用 Session Surface,但认证和资源授权分离;
- central working set 不能成为绕过 Server 的第二份本地权威。

## 7. 技术风险与控制措施

### 7.1 replicated backfill 的量与带宽

风险不是单个 `batch` 能否发送,而是大量历史 Session 同时首次启用 replicated:

- Journal 可能含高频 `assistant.delta`、工具结果摘要与长文本;
- 多 Worker 重连可能形成惊群;
- outbox 若为全部历史逐条持久化副本,会造成 Worker 磁盘双写和活跃命令饥饿;
- Server 校验、压缩、加密与索引会同时消耗 CPU、磁盘与 WAL。

控制措施:

1. backfill 按有界 chunk 流式读取,不要一次把完整 Session 入 outbox;
2. 每个 Session 最多一个在途 backfill chunk,应用层 receipt 后再读下一块;
3. 活跃增量优先于历史回填,command/receipt 优先于所有 backfill;
4. Server admission control 与 Worker jitter 限制同时回填数量;
5. 支持暂停、继续和磁盘高水位熔断;
6. P1 开工前用真实脱敏数据库测量事件数、原始/压缩字节、delta 占比、加密吞吐和重连峰值,再冻结默认 chunk 与带宽预算。

### 7.2 Pi checkpoint 与消息历史重建

现有 Pi RPC 的可靠能力是“记录并恢复 Native Session id”,不是“从 Wemux Journal 重建等价 Pi 会话”。单纯把历史消息再次发送会:

- 重复模型输入或工具副作用;
- 丢失 Pi 内部 compact、system prompt、extension、模型状态与 Provider 元数据;
- 将平台展示事件误当作模型上下文;
- 在不同 Pi 版本或资源 revision 下产生不同结果。

因此 P2 先做 capability probe 和恢复证据,再冻结 checkpoint v1。若 Pi 不提供可移植 export/import,replicated 仍可交付“历史灾备与人工恢复”,但不得声称任意 Worker 无缝续聊;central 继续阻塞。

### 7.3 central 与双宿主/离线语义

central 的核心冲突是 Server 权威要求在线提交,而双宿主保证 Worker 独立可用。解决方式不是复制一份隐形本地权威,而是把承诺拆开:

- Worker 独立 `local` 会话离线可写;
- replicated 集群会话可按 Worker 已接受操作策略离线推进,上线后补镜像;
- central 集群会话离线只读 working set 或安全停机,不接纳新 turn;
- central 模式切换必须由部署者显式确认此行为,UI 不得用“高可用”掩盖控制面依赖。

## 8. 开放问题

以下问题必须在对应票据中裁定,不得隐藏在实现默认值中:

1. **策略粒度**:部署默认按 Worker、Project 还是实例配置?是否允许单 Session override,谁有权限修改?
2. **本地会话发布**:独立 Worker 的 `local` Session 如何显式发布为集群 Session?身份、Project/Workspace 映射与历史授权如何建立?
3. **镜像保留与删除**:逻辑删除、用户导出、备份保留、法务保留、加密擦除各自期限是什么?
4. **镜像内容边界**:`assistant.delta`、tool input/output、附件、文件 diff、终端输出分别是否进入完整镜像?哪些只保留摘要或引用?
5. **backfill 默认预算**:chunk 大小、压缩算法、bytes/s、最大在途量、每日上限与磁盘高水位尚需真实数据冻结。
6. **现有 cache 演进**:权威镜像新建独立表后,projection cache 从镜像派生还是双写?如何避免两套连续水位漂移?
7. **checksum 与 generation**:采用逐 chunk hash、Merkle manifest 还是两者并用?Session 删除、compact 或未来事件修订是否创建新 generation?
8. **密钥托管**:Server mirror master key 来自环境、文件、KMS 还是外部 Vault?轮换、备份恢复和 key 丢失的运维合同是什么?
9. **Pi 可移植性**:目标 Pi 版本是否提供受支持的 Native Session export/import?跨 OS、不同 home、不同 extension 与不同模型是否兼容?
10. **semantic rebuild 产品语义**:若只能新建 Native Session 并注入摘要,UI 应称“恢复上下文”还是“从历史派生新会话”?如何保留 lineage?
11. **Workspace 状态**:迁移只引用 Workspace Placement,还是需要文件快照?未同步文件导致工具结果不可复现时如何提示?
12. **运行中迁移**:首版是否只允许 idle Session?长时间运行 Turn 的 drain 超时、强停与补偿由谁决定?
13. **central 可用性**:单 Server SQLite 是否足以承诺 central,还是必须先有外部对象存储/数据库、备份与恢复演练?
14. **central 完成原子性**:Journal、checkpoint、Run 投影和应用层 receipt 如何形成可恢复的提交边界?
15. **计费与配额**:镜像容量、出口带宽、导出和保留由实例、Project 还是 Worker 配额控制?
16. **降级规则**:mirror key unavailable、Server 磁盘不足、连续 gap 或版本不兼容时,新 turn 是 fail closed、降为 local,还是保持 replicated 但告警?禁止静默降级。

## 9. 分阶段实施与可验收票据

### 9.1 阶段定义

- **P0**:策略元数据与能力合同,无存储行为变化。
- **P1**:replicated 权威镜像、加密、backfill 与 Server 只读视图。
- **P2**:checkpoint v1、export/import 与经验证的恢复等级。
- **P3**:显式 Placement Migration、central 租约与存储分层。P3 之前不承诺 central。

### 9.2 P0 与 R2 的并入关系

P0 **随 R2 同批交付,但不并入 ResourceBinding 领域**:

- R2 已经修改 Agent runtime/Preset capability、Worker readiness 与重启合同,适合同时扩展 Worker 的 session-storage capability,避免随后再次破坏 capability schema;
- `Session.storageMode`、创建/继承规则、Web DTO 和数据库兼容属于 Session 领域,保留独立模块和独立测试;
- R2 的验收门禁增加“旧 Worker/旧 Session 兼容”和“新 capability 可观察”,但 P0 不阻塞 R2 的资源分发主路径;能力缺失时只能创建/读取为 `local`;
- 若 R2 已进入实现,以同一里程碑中的独立票据 S1、S2 合入,不得把未实现的 replicated 行为伪装为 R2 ready。

### 9.3 票据清单

#### S1(P0):冻结 storage policy 领域合同

范围:

- 定义 `local|replicated|central`、部署默认与 Session effective mode;
- 冻结 legacy 缺失字段按 `local` 读取;
- 明确 create、Task/Run create、reuse、fork、archive/delete 的继承与拒绝规则;
- 更新 Server/Worker/Web contract,但不启用复制行为。

验收标准:

- 使用含历史 Session 的真实 SQLite 副本启动,列表、详情、发送、归档和 fork 行为不回归,历史记录显示 `local`;
- requestId 幂等测试证明同一创建请求不会因默认策略变化产生不同 Session;
- 真实浏览器在集群宿主和 Worker 本地宿主分别创建 Session,前者展示 effective mode,后者固定显示本地存储且不出现 central 假入口;
- 复用现有 Session 浏览器脚本与 `apps/e2e` 动态端口/临时 home 惯例,保存脱敏截图与断言摘要。

#### S2(P0,随 R2):上报版本化存储能力

范围:

- capability 区分 mirror、export/import、四级 checkpoint 与 central lease;
- 旧 Worker 不带字段时按仅 `local` 处理;
- Web/API 展示能力与不可用原因,不从 Agent 名称猜测。

验收标准:

- 新 Server 连接旧协议 Worker、新 Worker 连接兼容 Server的测试给出明确 fallback 或 needs-attention,无假 ready;
- 用真实 Pi CLI 和 test adapter 采集 capability,Pi 在未完成迁移探针前只能报告 `native-resume-local`;
- 真实浏览器的 Worker 详情可看到存储能力、版本和原因;断开/重连后状态一致。

#### S3(P1):扩展现有 sync 为镜像 chunk/receipt 合同

范围:

- 不新增平行 `journal.sync` 状态机;
- 定义 manifest、generation、chunk identity、checksum、应用层 receipt、gap/corrupt 结果;
- 明确 transport ACK 不推进 mirror checkpoint。

验收标准:

- 自动化覆盖重复 chunk、乱序、断线、commit-before-receipt 崩溃、旧 socket close、Worker 重启与 Server 重启;
- 同一领域 chunk 重投只落一次,receipt 后不再发行;纯 ACK 不形成 ACK→重新入队忙循环;
- 用真实 transport SQLite 检查 outbox 最终归零且 mirror throughSeq 连续。

#### S4(P1):实现加密 SessionMirrorRepository

范围:

- 独立镜像 schema、manifest、chunk、checkpoint metadata 与状态;
- envelope encryption、AAD、keyId、多 key 读旧写新、fail closed;
- 不把正文存入 connector credential 表。

验收标准:

- 真实 SQLite 文件中正文关键字不可明文检出,篡改 ciphertext/AAD/checksum 后读取进入 `corrupt` 或 `key_unavailable`,不返回部分伪数据;
- 轮换 key 后新写使用新 keyId,旧数据仍可读;备份恢复演练记录所需 key material;
- 以至少一个脱敏大 Session 测量加密/解密吞吐、WAL 增长与恢复时间,结果写入验收摘要。

#### S5(P1):有界 backfill 与容量治理

范围:

- 每 Session 单在途 chunk、全局/Worker 限速、jitter、暂停/继续、磁盘高水位;
- 活跃 command/receipt/Journal 高于历史 backfill;
- 提供字节与 seq 进度。

验收标准:

- 使用真实脱敏数据集,至少覆盖小/中/大 Session、多 Worker 同时首次启用 replicated;
- 注入慢网、断网、Server 重启与磁盘高水位,证明活跃消息/审批不饥饿、内存有界、恢复后从 receipt 水位继续;
- 记录原始/压缩字节、峰值带宽、CPU、WAL、完成时间,据此冻结默认 chunk 和预算,不得只用合成十条事件验收。

#### S6(P1):交付授权后的 Server 只读镜像视图

范围:

- replicated 离线只读时间线、freshness、完整性和 backfill 状态;
- F1 投影读取安全 DTO,不直接暴露 mirror repository;
- local 模式保持现有 cache 语义。

验收标准:

- 真实浏览器创建 replicated Session并完成多轮对话、工具批准与模型事件;停止 Worker 后仍可读取已镜像历史,页面明确离线与最后水位;
- 无权用户、失去 Project/Worker 权限的用户不能读取镜像;Timeline 不出现聊天正文和 tool input/output;
- 制造 gap/corrupt/key unavailable,UI 分别展示可恢复诊断,不得显示“已同步”。

#### S7(P2):完成 Pi checkpoint 可行性探针并冻结 v1

范围:

- 对真实 Pi RPC 验证同 home 重启、不同 home、不同 Worker、版本变化与资源 revision 变化;
- 冻结 checkpoint capability 分级、格式和兼容矩阵;
- 明确 semantic rebuild 与 native resume 的产品差异。

验收标准:

- 使用真实 Pi CLI 完成不少于三轮含工具调用的会话,逐场景恢复并比较后续上下文、可用命令、模型、审批与副作用;
- 证明恢复过程不重新执行既有工具调用;无法等价恢复的场景必须标 `unsupported` 或 `semantic-rebuild`,不得以测试 adapter 代替;
- 将脱敏命令、版本、checkpoint manifest、结果差异和失败原因保存为可复查证据。

#### S8(P2):交付 export/import 与灾备恢复

范围:

- 版本化单文件容器、staging 校验、权限/redaction 清单、冲突处理;
- CLI 与内部服务共用同一实现;
- BYOK Secret 只迁移 locator。

验收标准:

- 从真实 replicated Session导出,在全新 Worker home 导入;hash 错误、截断、未知版本、Session ID 冲突、缺资源和缺凭证均 fail closed;
- 对 `native-export-import` 能力执行真实续聊;仅 `semantic-rebuild` 时创建有明确 lineage 的派生会话并在 UI 标注;
- 导出包解包检查无 Secret、token、transport credential 与未声明文件正文。

#### S9(P2):完成 replicated 灾难恢复演练

范围:

- 原 Worker 永久丢失时,从 Server 镜像选择目标 Worker恢复;
- 验证 Workspace、Agent、模型、资源 revision 与 credential locator;
- 保持旧 binding 直到目标验证完成。

验收标准:

- 杀死并移除源 Worker home,使用真实 Server 镜像恢复到另一 Worker;
- 真实浏览器观察 staging、缺项、恢复成功或安全失败;成功后继续一轮对话,历史连续且无重复工具副作用;
- 恢复中途断电/重启后可继续或回滚,Session 不进入双写状态。

#### S10(P3):实现显式 Placement Migration 状态机

范围:

- drain、final checkpoint、staging import、fencing、binding CAS、源归档;
- 首版只允许 idle Session;运行中迁移留待开放问题裁定。

验收标准:

- 真实浏览器发起迁移,活跃/排队 Session 被明确拒绝或先排空;
- 在每个阶段注入失败,证明原 Worker仍是唯一权威或新 Worker已完成唯一切换,不存在两个可写 owner;
- 审计记录操作者、来源/目标、generation、失败与回滚结果。

#### S11(P3):建立 central 存储端口与租约/fencing

范围:

- Server 权威 checkpoint/Journal commit、Worker working-set lease、generation/fencing token;
- SQLite adapter 与未来外部存储端口分离;
- 定义断线、续租、完成 receipt 和陈旧 Worker 写入拒绝。

验收标准:

- 两 Worker 竞争同一 Session时仅一个租约有效;旧 Worker 在 lease 失效后提交被拒绝且不能覆盖新 generation;
- Server 在 commit 前/后崩溃均能恢复出唯一终态;Journal、checkpoint 与 receipt 无“完成但不可恢复”窗口;
- 真实数据压力和备份恢复结果证明当前 adapter 达到冻结的 central SLO,否则 P3 保持实验状态。

#### S12(P3):central 双宿主与离线浏览器验收

范围:

- 模式切换确认、central 在线依赖、离线只读/停机状态、local 会话不受影响;
- 授权与 working set 隔离;
- 明确不可用原因和恢复动作。

验收标准:

- 真实浏览器同时打开一个 Worker 本地 `local` Session和一个集群 `central` Session;断开 Server 后本地会话可继续,central 不接纳新 turn并解释原因;
- 恢复 Server 后 central 从权威 checkpoint继续,未提交 turn不显示为已持久完成;
- 登录 Worker Web 的本机管理员不能读取未获集群授权的 central 内容;退出集群不删除本地会话,也不把 central working set变成本地权威。

### 9.4 阶段退出门槛

| 阶段 | 票据 | 退出门槛 |
|---|---|---|
| P0 | S1-S2 | 旧数据/旧 Worker兼容,能力可观察,无行为变化 |
| P1 | S3-S6 | replicated 在真实数据、断网、重启、权限与浏览器场景下形成完整加密镜像和只读视图 |
| P2 | S7-S9 | 至少一种真实 Agent Adapter 有可复查恢复等级;export/import 与丢节点恢复不夸大能力 |
| P3 | S10-S12 | 唯一写租约、原子完成、双宿主离线语义与 central SLO 全部通过;否则 central 不对外承诺 |

## 10. 明确不做

- 自动调度或自动迁移;首版只提供显式操作;
- 把 Server projection cache 直接改名为灾备而不补完整性、加密、保留和恢复证据;
- 会话正文的中心化全文检索;
- 跨实例、多 Server 会话联邦;
- 自动迁移或复制 BYOK Secret;
- 用消息历史重发冒充 Native Session 等价恢复;
- 为共享 UI 建第二套 Session 状态机;
- 在 P3 门槛通过前宣传 central 或任意节点无缝接管。
