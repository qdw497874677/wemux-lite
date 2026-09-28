# 节点资源分发层架构设计

## 摘要

本文设计统一的节点资源分发层：Server 以不可变 revision 管理 Skill、Agent 运行时、模型供应商和连接器配置，通过 ResourceBinding 分配，Worker 校验后原子物化。空服务器安装并注册 Worker 后，管理员只需在 Web 应用节点资源预设，即可观察下载、校验、安装、重启、凭证就绪与能力上线。方案复用连接器可靠推送管道和现有 Agent 安装器，坚持 BYOK，Server 只分发非秘密配置与凭证引用。连接器保留既有执行管道并纳入统一分配和状态投影。实施分三批：先吸收 G51 与 Skill，再闭合 Agent runtime 和 Preset 快速路径，最后落地模型供应商配置。

## 1. 目标、边界与依据

### 1.1 要解决的场景

目标场景是：一台只有受支持操作系统、Node 与基础网络能力的空服务器，通过 Worker 安装器加入集群后，不再要求管理员 SSH 登录逐项准备，即可由控制面把标准 Agent 运行时、Skill 与模型供应商非秘密配置分配到该节点，并在 Web 中看到安装进度、失败原因和最终能力。

这里的“零手工节点准备”指注册完成后的资源准备由控制面驱动，不等于零下载、零凭证所有权确认或零基础设施前提。Agent 包仍需要从受信来源下载，BYOK Secret 仍必须在 Worker 信任域内提供，操作系统、Node、磁盘和出站网络仍需满足兼容性要求。

### 1.2 已核实的现有基础

| 基础 | 已有事实 | 对本设计的含义 |
|---|---|---|
| Worker 安装 | `apps/server/src/http/worker-downloads.ts` 提供 `/downloads/install-worker.sh` 与 `/downloads/worker.tgz`；安装脚本执行全局 npm 安装，可用 enrollment token 注册并以前台方式启动 | 裸机到在线节点已有路径，但当前 tarball 没有 manifest 校验、managed store、用户级服务和自动回滚，资源层不能假设这些发布能力已经存在 |
| Agent 托管安装 | `apps/worker/src/runtimes/management.ts` 的 `installAgent()` 只接受固定目录中的 Pi、OpenCode、Claude Code，安装到 `<worker-home>/agents/<key>/`，隔离 npmrc，验证包名、版本、bin 和 `--version` 后才写 `agents.json` | `agent-runtime` 不新造下载器，复用该安装器；资源层只把“装什么版本、分配给谁”变成控制面数据 |
| Agent 变更生效 | `apps/worker/src/config/agent-settings.ts` 持久化 managed/local 选择；`apps/worker/src/cli.ts` 明确提示变更后需重启 Worker，登录和模型配置另行完成 | R2 必须设计受控重启或明确的 `restart_required` 状态，不能把文件落盘误报为 ready |
| Skill 注入基础 | `packages/domain/src/capabilities.ts` 已有 `CapabilityAssetKind = 'skill'`；`apps/worker/src/application/agent-launch-context-provider.ts` 校验 SHA-256 并为 Turn 建隔离目录；`apps/worker/src/agents/pi-agent.ts` 通过 `--skill` 注入目录 | G51 的 revision 缓存可替代每次传全文，但 launch preparation 和 Agent Adapter 注入 seam 可直接复用 |
| 连接器分发 | `packages/wire-protocol/src/commands.ts` 已有 `connector.definition.sync/revoke/test`；`apps/server/src/application/connector-service.ts` 持久化 Command 与 distribution；`apps/worker/src/connectors/runtime.ts` 合并集群定义、检查本地凭证并回报 `ConnectorRevisionReport` | 已验证“不可变 revision -> 可靠 Command -> Worker 应用 -> 领域 report”的推送管道，应复用其消息骨架和投递纪律 |
| BYOK | `docs/design/connector-module-borrow-and-hexagon-boundaries.md` 冻结“凭证永不上 wire”；`apps/worker/src/connectors/credential-store.ts` 只在 Worker 使用 SecretCodec 解密本地密文 | 模型供应商 Secret 同样只能在 Worker 解析，Server 只保存引用和安全状态 |
| G51 | `docs/design/feature-suite-approvals-routines-architecture.md` 2.4 已裁定 Skill/Revision/Binding、1 MiB、64 文件、内容寻址 blob、静态内容、launch 固定 revision、A3 和幂等 | R1 完整吸收这些裁定，不另建平行 Skill 分发模型 |
| Paperclip 安装模式 | `docs/research/paperclip-deep-dive.md` 2.1 核实 staging、不可变安装目录、原子 `current`、`previous`、稳定 shim、健康失败回滚 | Worker 程序升级和节点资源物化应共享模式，不共享生命周期或同一个 current 指针 |
| Paperclip Skill catalog | `paperclip-upstream/paperclip/packages/skills-catalog/src/types.ts` 与 `src/catalog-builder.ts` 使用生成 manifest、文件 SHA-256、contentHash、trustLevel、兼容性和 bundled/optional 分类 | 可借 catalog 构建期验证和不可变清单，不照搬 GitHub 引用下载与 executable skill 信任级别 |

### 1.3 与 Paperclip“五零接入”的边界对照

Paperclip 的本地可信 onboarding、Tailnet 私网访问和 Stream 类自发连接可减少公网入口、证书和端口准备。Wemux 的目标不是宣称所有基础设施为零，而是把节点加入后的软件与配置准备降为零 SSH 操作：

1. **可消除**：逐机下载安装 Agent、复制 Skill、手写非秘密 provider 配置、逐机核对目标版本。
2. **不可消除**：安装 Worker 的首次命令或镜像启动、节点到 Server 和制品源的网络、Agent 包体下载时间、BYOK Secret 在 Worker 信任域内的首次注入、部分 Agent 的交互登录或厂商 OAuth。
3. **零公网边界**：Worker 主动连接 Server，资源命令复用该长连接；Server 不需要主动访问 Worker。若 Server、npm 制品源和 Secret backend 均可经内网或 Tailnet 到达，节点不需要公网入站。若 Agent runtime 只能从公网 npm 获取，仍需要出站或内部镜像。
4. **不作虚假承诺**：当前 installer 依赖 `npm install --global` 且前台启动，不具备 Paperclip 式 managed store 和 service rollback。该缺口属于 Worker 发布安装层，资源层在 R2 验收时必须把它列为前置能力或一并补齐。

## 2. Before/After：空服务器场景

| 阶段 | Before：当前步骤 | 当前人工点 | After：资源分发层 |
|---|---|---|---|
| 1. 安装 Worker | 下载并运行 installer，installer 从 Server 取 tgz，再执行 npm 全局安装 | 需要在目标机执行一次命令；当前还需保证 npm、Node 和前台进程存活 | 仍需一次 bootstrap；生产路径升级为带 manifest、SHA-256、稳定服务与回滚的安装，但不把 Agent runtime 塞进 Worker 包 |
| 2. 加入集群 | 提供 Server URL、enrollment token、Worker name，执行 register/start | 需处理地址、令牌和进程托管 | 安装命令内完成 register 和服务启动；Server 发现 `resourceState=unconfigured` 的新节点 |
| 3. 安装 Agent | SSH 到节点，逐个执行 `wemux-lite-worker agent install pi|opencode|claude --yes --home ...` | 每台节点逐项执行，等待下载，失败需登录排查，变更后重启 | 管理员在 Web 应用 Preset；Worker 收到 `agent-runtime` binding 后复用 `installAgent()`，报告下载、校验、安装、重启等待与 ready |
| 4. 配置模型 | 在节点上设置环境变量、运行 Agent 登录命令或编辑 Agent 自身配置 | Secret 不能由集群 Web 代填；不同 Agent/provider 方法不同 | Server 下发 endpoint、模型清单和 credential locator；Worker 从本地加密凭证、环境变量或 Vault 解析。缺 Secret 时状态为 `credential_required`，可跳转 Worker 本地工作台完成 |
| 5. 配置连接器凭证 | 集群 Web 建非秘密定义，Worker 本地工作台录入 Secret，再触发测试 | 仍需在目标 Worker 的信任域录入 BYOK Secret | Preset 可分配 connector-config；已有 revision sync 应用定义。Secret 继续本地录入或按 locator 从 Vault 获取，不经过 Server |
| 6. 分发 Skill | G51 尚未实施；当前 capability asset 可在 Turn 中携带内容并临时写目录 | 缺少目录、版本、绑定、缓存、回滚与 Web 状态 | `skill` revision 写入 Server 内容寻址 blob，ResourceBinding 分配，Worker 缓存并在 launch 固定 revision 注入 |
| 7. 验证可用 | 手工运行 `agent status`、检查模型、创建 Session 试跑 | 状态分散，容易把“已下载”误认作“可执行” | Web 节点详情汇总每项 materialization 与能力探测；只有 runtime 可执行、凭证可解析、至少一个模型可用且所需 Skill ready 时节点进入 preset ready |

**对照结论**：After 把注册后的四类配置操作从“登录每台服务器”改为“控制面分配并观察”。唯一保留的节点侧安全动作是 Secret 的本地注入或 Vault 授权，以及确实无法非交互完成的厂商登录。

## 3. 资源抽象

### 3.1 为什么现在可以建立通用层

仓库铁律要求第二个真实 kind 出现后才抽通用接口。本设计面对的不是假想插件：

- `skill` 是小体积、多文件、只读 launch 资产；
- `agent-runtime` 是大体积、安装脚本风险高、需版本探测和进程重启的软件；
- `model-provider` 是小体积非秘密配置，但 ready 依赖 Worker 本地 Secret；
- `connector-config` 已有独立领域 revision、凭证状态与 sync/report。

四者共同需要 revision、target、binding、可靠投递、状态与追赶，但物化动作、体积、风险和 ready 条件真实不同，因此建立一个小而深的分发接口，并保留四个 kind adapter，是有证据的变化点。

### 3.2 核心类型

```ts
export type ResourceKind =
  | 'skill'
  | 'agent-runtime'
  | 'model-provider'
  | 'connector-config'

export interface ResourceRevision {
  readonly resourceId: string
  readonly kind: ResourceKind
  readonly revision: number
  readonly state: 'draft' | 'published' | 'retired'
  readonly manifest: ResourceManifest
  readonly payload:
    | { readonly mode: 'blobs'; readonly files: readonly ResourceFile[] }
    | { readonly mode: 'artifact'; readonly artifact: TrustedArtifactRef }
    | { readonly mode: 'inline-config'; readonly contentSha256: string }
    | { readonly mode: 'domain-ref'; readonly domainId: string; readonly domainRevision: number }
  readonly contentSha256: string
  readonly createdBy: UserId
  readonly createdAt: Timestamp
}

export interface ResourceManifest {
  readonly schemaVersion: 1
  readonly name: string
  readonly description: string
  readonly compatibility: {
    readonly workerProtocol: string
    readonly platforms: readonly string[]
    readonly architectures: readonly string[]
    readonly agentKeys: readonly AgentKey[]
  }
  readonly bytes: number
  readonly fileCount: number
  readonly sha256: string
  readonly materializerVersion: number
  readonly restartPolicy: 'none' | 'agent-process' | 'worker'
}

export interface ResourceFile {
  readonly path: string
  readonly size: number
  readonly mediaType: string
  readonly sha256: string
  readonly blobSha256: string
}

export interface ResourceBinding {
  readonly id: string
  readonly resourceId: string
  readonly kind: ResourceKind
  readonly target: {
    readonly workerIds: readonly WorkerId[]
    readonly agentKey: AgentKey | null
    readonly projectId: ProjectId | null
  }
  readonly selectedRevision: number
  readonly enabled: boolean
  readonly revision: number
  readonly createdBy: UserId
  readonly updatedAt: Timestamp
}
```

裁定：`ResourceBinding` 是“哪一版资源应出现在哪些 Worker、Agent 和 Project 范围”的唯一权威表达。Project 为空表示节点级资源，`agentKey` 为空表示不限定 Agent。运行时最终可用范围仍要与 A3、Session、Workspace Placement 和 capability snapshot 求交，binding 不能扩大权限。

裁定理由：若 SkillBinding、runtime assignment、provider assignment 和 connector `allowedWorkerIds` 各自成为分配权威，Preset 无法原子表达，状态汇总会出现四套漂移。各领域可以保留自己的定义和编辑模型，但目标选择统一写成 ResourceBinding。

### 3.3 四个 kind 的 revision 与路径

| kind | manifest 特有字段 | payload | Worker 目标路径 | ready 条件 |
|---|---|---|---|---|
| `skill` | `entryFile='SKILL.md'`、compatibleAgents、containsExecutableFiles=false | `blobs`，文件指向 Server `resources/blobs/<sha256>` | `<worker-home>/resources/skill/<id>/<revision>/` | 全文件 hash 通过，目标 Agent 支持注入，launch view 可创建 |
| `agent-runtime` | runtimeKey、官方包名、精确版本、bin、registry origin、package integrity、最低 Worker/OS/arch | `artifact`，首版为固定 npm artifact 引用 | `<worker-home>/resources/agent-runtime/<id>/<revision>/` 保存安装收据；实际包目录继续位于现有 `<worker-home>/agents/<key>/...` | 安装器验证包名/版本/bin，`--version` 与兼容范围通过，选择已写入，所需重启完成，detect 为 execution capable |
| `model-provider` | providerKey、endpoint、模型清单、Agent 适配映射、credential locator、TLS/网络策略 | `inline-config`，仅非秘密 JSON | `<worker-home>/resources/model-provider/<id>/<revision>/` | 配置 hash 通过，credential locator 可解析或标为 not_required，Agent 探测到指定模型 |
| `connector-config` | 复用 ConnectorDefinition 的 kind、riskDefaults、credentialRef 与网络策略 | `domain-ref` 指向 connectorId + revision | 可写只读 receipt 到 `<worker-home>/resources/connector-config/<id>/<revision>/receipt.json`；权威定义仍在 `worker.sqlite` | 已有 connector runtime 应用 definition，凭证状态满足要求，测试策略通过 |

所有 kind 都有 `contentSha256`，但不强迫所有资源都复制成 blob。内容寻址适合 Skill，小配置可 canonical JSON 后计算 hash，大 runtime 使用受信 artifact 引用，连接器使用已有不可变领域引用。统一的是 revision、binding、投递和状态，不是把不同内容硬塞进同一存储形态。

### 3.4 连接器是否并入

**裁定：逻辑并入 Resource catalog、Binding、Preset 和状态投影，物理上保留现有 Connector domain 与 revision sync 管道。**

收益：

1. Preset 可以同时表达 runtime、Skill、provider 和 connector，不再额外调用连接器分发接口。
2. Worker 节点详情得到统一资源状态，离线追赶和失败重试有一致交互。
3. `ResourceBinding` 取代 `allowedWorkerIds` 作为分配权威，避免相同定义有两套目标列表。

迁移成本：

1. 现有 Connector CRUD、A3、测试、credential availability 和 capability snapshot 已稳定，若改成通用 blob materializer 会损失领域语义并扩大回归面。
2. `apps/server/src/application/connector-service.ts` 与 `apps/worker/src/connectors/runtime.ts` 已实现 revision sync/report，重写没有收益。
3. 现有 Web/API 的 `allowedWorkerIds` 需要兼容迁移：读取时投影 ResourceBinding，写入旧字段时在一个事务中转换为 binding，完成客户端迁移后停止接受旧写法。

因此通用调度器遇到 `connector-config` 时调用 Connector distribution adapter，wire 继续使用 `connector.definition.sync/revoke`。这不是两套分配权威，旧管道只是 ResourceBinding 的执行 adapter。

### 3.5 Worker 物化器

Worker 侧建立一个深模块 `ResourceMaterializer`，外部接口保持为：

```ts
materialize(command: ResourceSyncCommand): Promise<ResourceMaterializationReport>
revoke(command: ResourceRevokeCommand): Promise<ResourceMaterializationReport>
reconcile(desired: readonly ResourceBindingSnapshot[]): Promise<ReconcileResult>
```

内部按 kind 分派到 `SkillMaterializer`、`AgentRuntimeMaterializer`、`ModelProviderMaterializer` 和 `ConnectorConfigDistributionAdapter`。外部调用方不处理下载、staging、锁、hash、current、previous、清理或重试。

目录约定：

```text
<worker-home>/resources/
  blobs/<sha256>
  staging/<operation-id>/
  skill/<resource-id>/<revision>/
  agent-runtime/<resource-id>/<revision>/
  model-provider/<resource-id>/<revision>/
  connector-config/<resource-id>/<revision>/
  state.sqlite
```

物化步骤冻结为：

1. 读取 binding 与 revision，拒绝目标 Worker 不匹配、revision 倒退和 manifest 不兼容。
2. 以 `(kind, resourceId)` 获取 Worker 本地锁；同 revision 同 hash 返回幂等成功，同 revision 异 hash 报安全冲突。
3. 下载或组装到 `staging/<operation-id>`，逐文件限制路径、大小、总量与符号链接。
4. 计算每个文件和整体 SHA-256，任何不一致均删除 staging，不触碰 active。
5. 执行 kind probe，例如 Skill entry 检查、runtime `--version`、provider schema 与 credential locator 检查。
6. rename 到不可变 revision 目录，再原子更新 `current` 相对 symlink；不支持可靠 symlink 的平台用同目录原子 rename 的 pointer manifest。
7. 保存 `current`、`previous`、binding revision、lastUsedAt、bytes、状态与错误安全摘要。
8. 运行激活后健康检查。失败时原子恢复 previous，并报告 `rolled_back`，不得把失败 revision 标 ready。

revision 变化总是重建新的不可变目录，不在原目录补丁更新。运行中的 Invocation 固定旧 Skill revision；新的 Invocation 才读取新 binding。Agent runtime 更新先安装并探测，再进入 `restart_required`，由受控重启切换，不能在活跃 Turn 中替换进程树。

### 3.6 缓存、引用与回收

1. 当前 binding 引用、previous 回滚引用、活跃 Invocation 引用和进行中 staging 都是强引用，不可回收。
2. 未引用 revision 进入 LRU，默认每 kind 至少保留一个 previous；默认总预算建议为 Worker 可用磁盘的 20%，并受绝对上限控制。首版绝对默认值在实现规格中按真实 Pi/Claude 包体测量后冻结，不在架构文档虚构。
3. 回收前重新核对引用计数，删除采用 rename 到 trash 后异步清除，防止长删除阻塞 materialization lock。
4. 磁盘不足时先回收无引用 LRU，再拒绝新资源并报告所需字节、可用字节和可回收字节，绝不删除 active/previous。
5. 离线节点重连先接收 desired snapshot，再按 revision 缺口追赶；已持有相同 hash 的 blob 不重复下载。

### 3.7 与 `agent install` 的关系

**裁定：`agent-runtime` 复用 `apps/worker/src/runtimes/management.ts` 的安装器语义，Resource kind 只负责控制面目录、版本选择、目标分配和状态机。**

首步应把现有 `installAgent()` 的固定 catalog、npm 隔离、staging、manifest/bin 验证和 selection 写入收敛为可由 CLI 与 ResourceMaterializer 同时调用的内部模块。CLI 继续是本地管理入口，控制面路径不得 shell 调用 CLI，也不得接受任意 package spec 或 URL。

理由：现有安装器已经体现官方固定版本、失败不改选择、非全局安装和 `--version` probe。再造下载器会形成两套供应链规则。Resource 层新增的是可靠分配和生命周期，不是新的 npm 客户端。

## 4. 分发协议、状态与幂等

### 4.1 wire 命令族

通用消息骨架建议为：

```ts
type ResourceCommand =
  | { kind: 'resource.revision.sync'; requestId: string; binding: ResourceBindingSnapshot; revision: ResourceRevisionWireSnapshot }
  | { kind: 'resource.binding.revoke'; requestId: string; bindingId: string; bindingRevision: number }
  | { kind: 'resource.reconcile'; requestId: string; desiredSetRevision: number; bindings: readonly ResourceBindingSnapshot[] }

type ResourceMaterializationStatus =
  | 'queued' | 'downloading' | 'verifying' | 'installing'
  | 'restart_required' | 'ready' | 'credential_required'
  | 'unavailable' | 'failed' | 'rolled_back' | 'revoked'
```

报告至少包含 `requestId`、`bindingId`、`resourceId`、kind、目标 Worker、resource revision、binding revision、status、progress bytes、safe errorCode/message、activeRevision、previousRevision、occurredAt。

**裁定：复用 connector sync 的消息骨架和可靠 Command 基础设施，不把 connector 命令改名后强行塞入通用 union。** 新的三种 materialized kind 使用 `resource.*`；connector adapter 继续发 `connector.*`，但两者由同一个 ResourceDistributionScheduler 调度并写统一 distribution projection。

理由：可靠投递的共同机制是稳定 commandId、requestId、outbox、receipt、领域 report 和重连重放，而不是判别值必须相同。保留现有 connector wire 可降低迁移风险，也让领域测试继续有效。

### 4.2 ACK、receipt 与 report

1. transport ACK 只允许促使 outbox 重放，不能重新创建 Resource Command。
2. `CommandReceipt accepted` 只表示 Worker 已持久记录，不表示安装完成。
3. 领域 report 才推进 `downloading -> verifying -> installing -> ready|failed`。
4. 领域身份固定为 `(bindingId, bindingRevision, resourceRevision, workerId)`；重试保持该身份，只允许新的传输序号。
5. 同 requestId 同 fingerprint 幂等重放；同 requestId 异 fingerprint 返回冲突。
6. binding 更新使用 CAS `expectedRevision`；Preset 应用也使用 requestId、fingerprint 和 preset revision。
7. 收到成功或终态失败 report 后，Server 删除该领域身份的待发行记录，不能由后续纯 ACK 再入队。

这些规则直接继承 `AGENTS.md` 的有界事件触发投递约束，并与现有 `ConnectorService.enqueueDefinition()` 的可靠命令模式一致。

## 5. 安全、凭证与供应链

### 5.1 Model provider 的 Secret 三方案

| 方案 | 优点 | 缺点 | 裁定 |
|---|---|---|---|
| A. Server 加密保存，推送时解密 | 集群 Web 一处录入，应用 Preset 最顺滑 | Secret 进入 Server 数据库、内存、备份和 wire 发送面，违背 G42 “Worker 凭证只在 Worker 解析”，控制面失陷可取得全节点 key | 拒绝 |
| B. Worker 本地录入，Server 只推 provider 与模型 | 完全符合 BYOK，复用 Worker 本地加密存储 | 每个 Worker 首次仍需本地操作；大量节点录入成本高 | 支持，作为无 Vault 环境的安全基线 |
| C. Server 推送引用式获取指令，如环境变量名或 Vault 引用 | Secret 不进入 Server，节点可由基础设施预置环境或 workload identity 自动取值，最符合无人值守 | 需要定义受限 locator，Vault adapter 需真实第二实现后再抽接口，环境变量更新可能要求重启 | 推荐默认 |

**推荐：C 为标准路径，B 为本地 fallback，A 明确禁止。**

`model-provider` revision 只允许如下非秘密 locator：

```ts
type CredentialLocator =
  | { kind: 'worker-credential'; credentialRef: string }
  | { kind: 'environment'; variableNames: readonly string[] }
  | { kind: 'vault-ref'; backend: 'configured-worker-vault'; path: string; fieldNames: readonly string[] }
```

Server 保存并下发 locator，不解析结果。Worker 在 materialize probe 或 Agent launch 前解析，Secret 只进入目标 Agent 子进程的最小环境，不写 report、日志、manifest 或 capability snapshot。`vault-ref` 首版只定义合同，只有在仓库出现真实 Vault adapter 后才开放 UI；在此之前产品可用路径是 environment 与本地 `worker-credential`，不提供假按钮。

本地凭证存储应复用 G42 的 SecretCodec 与 fail-closed 行为，但 owner 扩展为 `model-provider`，不能把模型 key 冒充 connector credential。Server 只接收 `not_required|unconfigured|available|unavailable|invalid` 状态。

### 5.2 与 G42 契约的一致性

以下规则直接继承，不另设例外：

1. Secret 永不上 `packages/wire-protocol`，wire 只出现 credentialRef、locator 元数据和可用状态。
2. 缺 Worker 加密 key 时，基础 Worker 可上线，但本地密文凭证能力为 unavailable，相关 provider fail closed。
3. 执行前按 revision 重新解析凭证，不能因 materialize 时曾成功就永久缓存明文。
4. 日志和 report 只保留安全摘要，扫描类型可达图和序列化 fixture，防止 apiKey、authorization、token、password、ciphertext 等字段进入资源 wire。
5. A3 只控制谁可分配 provider，不赋予其读取 Worker Secret 的能力。

### 5.3 Agent runtime 供应链安全

1. 仅允许代码内或签名 catalog 中的官方包名、精确版本、bin 和 registry origin。不得从 ResourceRevision 接受任意 URL、Git ref、shell command 或 npm range。
2. manifest 同时固定 npm integrity 或发布产物 SHA-256、解包后关键文件 hash、大小、平台、架构、Worker 协议兼容范围。
3. 下载到 staging，先验证大小和 hash，再安装与 `--version` smoke，最后原子激活。失败保留 active。
4. 安装脚本风险必须在 Preset 应用确认页显示。对需要 lifecycle scripts 的官方包使用显式 allowlist，不能由用户切换 `ignore-scripts` 绕过审计。
5. 正式发布应采用不可变 artifact 后移动 channel 指针。Paperclip 的 pinning、staging、current/previous 和健康失败回滚模式可借用；仅有同源 checksum 只能防损坏，后续应增加离线签名或透明发布证明。
6. 并发安装按 runtimeKey 串行，超时、stdout/stderr 和子进程树清理继续遵守现有 `runRuntimeProcess` 上限。

### 5.4 Skill 安全裁定

R1 完整继承 G51：

- 单 revision 总大小 1 MiB，最多 64 文件。
- 入口固定 `SKILL.md`。
- 路径规范化，拒绝绝对路径、`..`、NUL、符号链接。
- 只允许 Markdown、文本、JSON 和小型静态资源。
- `containsExecutableFiles` 必须为 false，拒绝脚本、二进制和外部网络 import。
- Skill 只能收窄能力，不授予 Secret、Connector、网络或文件范围。
- launch preparation 固定 revision，运行中不热替换。
- Project manager 管理与绑定；分发还要求目标 Worker manage；执行要求 Worker use 与 Session/Project 权限交集。

Paperclip skills-catalog 的 `trustLevel='scripts_executables'` 不适用于首版 Wemux Skill。可借 manifest 构建、contentHash、文件清单和 packaged artifact 测试，不借可执行技能信任等级。

### 5.5 Preset 权限放大控制

Preset 能批量给多节点安装软件，权限高于普通 Project 配置：

1. 创建、发布、修改实例级 Preset 只允许实例管理员；Project manager 只能创建 Project 范围且目标 Worker 必须拥有 manage。
2. 应用 Preset 时重新检查每个资源和 Worker 的当前 A3，不信任创建时快照。
3. 首次注册自动应用策略只允许实例管理员开启，默认关闭，并可限定 Worker label、平台和 enrollment profile。
4. Preset revision 不可变；修改生成新 revision。应用历史记录精确的 preset revision 和展开后的 binding fingerprints。
5. Web 确认页展示将安装的软件、版本、下载体积、是否执行 npm scripts、是否要求重启和缺失凭证，不允许用“标准配置”隐藏副作用。

## 6. 空服务器快速路径

### 6.1 NodeResourcePreset

```ts
export interface NodeResourcePreset {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly revision: number
  readonly scope: { readonly kind: 'instance' } | { readonly kind: 'project'; readonly projectId: ProjectId }
  readonly entries: readonly {
    readonly resourceId: string
    readonly selectedRevision: number
    readonly agentKey: AgentKey | null
    readonly projectId: ProjectId | null
    readonly enabled: boolean
  }[]
  readonly autoApply: {
    readonly enabled: boolean
    readonly enrollmentProfileIds: readonly string[]
    readonly requiredLabels: Readonly<Record<string, string>>
  }
  readonly createdBy: UserId
  readonly createdAt: Timestamp
}
```

Preset 是 ResourceBinding 模板，不是第五种资源，也不复制 ResourceRevision。应用时展开为一组独立 binding，并记录共同 `presetApplicationId`。首版不承诺跨多个 Worker 的数据库级全局原子安装，因为物化是分布式长操作；控制面只保证绑定创建事务一致、每项幂等、状态可汇总和失败可重试。

示例“标准编码节点”：

- Pi 0.85.1 runtime；
- Claude Code 2.1.34 runtime；
- 默认静态 Skill 集；
- OpenAI 兼容或 Anthropic provider 非秘密配置及 environment locator；
- 可选 Project connector-config。

### 6.2 端到端流程

1. 管理员从 Server 获取绑定实例地址与一次性 enrollment token 的安装命令。
2. installer 安装 Worker、register、安装用户级服务并启动；Server 收到 Worker 身份、平台、架构、磁盘和现有 Agent capability。
3. 新节点显示为 `online / resources_unconfigured`。若显式开启匹配的 autoApply，Server 立即创建 Preset application；默认要求管理员点击“应用资源预设”。
4. Server 展开并 CAS 创建 ResourceBinding，按依赖顺序发送：provider 非秘密配置与 Skill 可并行，runtime 按 runtimeKey 串行，connector 走既有 sync adapter。
5. Worker 对每项持久记录命令，阶段性 report：`queued -> downloading -> verifying -> installing -> restart_required -> ready`。缺 Secret 使用 `credential_required`，不是 generic failed。
6. runtime 全部安装后，Worker 仅在无活跃 Turn、无 queued mutation 且服务管理可用时受控重启。若不能自动重启，Web 明确显示“已安装，等待重启”，不宣称 ready。
7. Worker 重连后 reconcile desired bindings，重新 detect Agent、模型和 Skill 注入能力，上报 capability inventory。
8. Preset 的 required entries 全部 ready，节点状态变为 `ready`；optional entry 失败则为 `ready_with_warnings`。Web 可直接创建一个验证 Session 运行无副作用 prompt。

### 6.3 Web 进度与诊断

节点详情增加“资源”页签：

- 顶部显示 Preset、总体状态、下载总量、磁盘预算、最近 reconcile 时间。
- 每项显示 kind、名称、目标 revision、active/previous revision、阶段、百分比、速度、重试次数、credential availability 和安全错误摘要。
- 操作包括重试、回滚、撤销 binding、打开 Worker 本地凭证页、查看审计。操作按 A3 后端 capability 返回，前端不猜角色。
- `credential_required` 提供 environment 名称或 Vault locator 诊断，但不展示 Secret 值。
- Worker 离线时显示 `waiting_for_worker`，上线后自动追赶，不让管理员反复点击产生新 Command。

### 6.4 更新与回滚

1. 发布新 ResourceRevision 不自动改变已锁定 binding。管理员升级 Preset 或 binding 才移动 selectedRevision。
2. 批量升级分批投递并加随机抖动；默认每批节点数和并发下载数由部署配置，避免 N 节点同时拉 Agent 大包。
3. Skill/provider revision 可在 probe 成功后立即切换，新 Invocation 生效。
4. Agent runtime 先安装、探测、记录 previous，再排空并重启。重连后 capability probe 失败则回滚 previous 并再次重启。
5. connector-config 继续使用现有 revision sync/revoke 与 report；credential 不可用不会回滚非秘密定义，而是保持 `credential_required/unavailable`，因为旧 revision 未必拥有可用 Secret。
6. 回滚是创建指向旧 immutable revision 的新 binding revision，保留完整审计，不直接篡改历史 selectedRevision。

## 7. 六边形模块划分

### 7.1 Server 控制面

| 模块 | 职责 | 不负责 |
|---|---|---|
| ResourceCatalog | Resource、不可变 revision、manifest、blob/artifact ref、发布与退役 | Worker 文件写入、Secret 解析 |
| ResourceBindingService | 唯一分配权威、A3、CAS、requestId/fingerprint、Preset 展开 | 下载和安装 |
| ResourceDistributionScheduler | desired state 与实际 report 对比、Command 入队、离线追赶、节流 | transport ACK 生成新领域命令 |
| ResourceBlobStore | Server data 下内容寻址 blob、staging、hash、备份一致性 | 任意 URL proxy |
| ResourceDistributionProjection | 汇总 connector 与 resource report，供 Web 查询 | 成为执行权威 |
| NodeResourcePresetService | Preset revision、应用、autoApply 策略、审计 | 绕过逐资源 A3 |

存储继续使用 node:sqlite 和 Server 管理文件目录。数据库与 blob 目录必须作为同一恢复集。

### 7.2 Worker 执行面

| 模块 | 职责 |
|---|---|
| ResourceCommandHandler | 持久接收 sync/revoke/reconcile，验证目标和幂等身份 |
| ResourceMaterializer | staging、hash、原子激活、previous、回滚、LRU、磁盘预算 |
| Kind adapters | Skill 文件物化、runtime 安装器复用、provider 配置与 locator probe、connector sync 适配 |
| ResourceStateStore | binding desired/actual、引用、进度、错误、active/previous revision |
| CapabilityReporter | 重新 detect Agent、模型、Skill 支持和 connector 状态，形成节点 ready 判定 |
| LaunchResourceResolver | 按 Session/Project/Agent/A3 交集解析固定 revision，建立 Invocation 只读视图 |

### 7.3 共享契约

- `packages/domain`：ResourceKind、ResourceRevision、ResourceBinding、Preset 和状态机中的纯领域类型。
- `packages/server-domain`：目录、绑定、Preset、分发投影与授权用例。
- `packages/wire-protocol`：非秘密 `resource.*` Command/report；connector wire 保持现有类型。
- `packages/web-contract`：目录、binding、Preset、节点资源状态 DTO。

依赖方向保持 Worker 不 import `@wemux/server-domain`。kind adapter 是 Worker 内部 seam，不把 npm、文件系统或 Connector runtime 细节泄漏到 wire。

## 8. 分批实施与估时

估时按一名熟悉仓库的工程师，每人日 8 小时，包含合同、迁移、单元/集成、真实浏览器、真实 Worker 验收和脱敏验收摘要。

### R1：通用层 + Skill kind，吸收 G51

**估时：80 至 112 小时，10 至 14 人日。** 原 G51 为 56 至 80 小时，增加 24 至 32 小时用于通用 Resource/Binding、状态投影、reconcile 和 connector adapter 合同。

交付物：

- Resource/Revision/Binding 领域合同、SQLite repository、Server blob store。
- `resource.revision.sync/revoke/report` 与可靠投递。
- Worker ResourceMaterializer、原子 staging/current/previous、hash、引用与 LRU。
- Skill Studio 编辑、发布、绑定、分发、状态和 launch 注入。
- connector-config 的统一状态投影与 binding 兼容迁移设计，不重写 connector runtime。
- G51 的 1 MiB、64 文件、静态内容、A3、幂等、固定 revision 和两 Worker 验收全部落地。

验收：真实浏览器编辑并发布 Skill，绑定 Pi，分发到两 Worker；运行中 Invocation 固定旧 revision，新 Invocation 使用新 revision；断线重连追赶；hash 失败不激活；撤权后新 Invocation 不注入；LRU 不删除 active/previous。

### R2：Agent runtime + Preset + 空服务器快速路径

**估时：104 至 144 小时，13 至 18 人日。** 其中 runtime materializer 40 至 56 小时，Preset/Web 32 至 40 小时，installer/service/重启与真实裸机验收 32 至 48 小时。

交付物：

- 把现有 `installAgent()` 收敛成 CLI 与 Resource adapter 共用安装模块。
- runtime manifest、固定 artifact、SHA-256/integrity、probe、previous、受控重启和回滚。
- NodeResourcePreset、手工应用、默认关闭的 autoApply、进度 UI。
- Worker installer 的 immutable manifest、managed install、用户级服务和健康检查，至少完成 Linux 支持；否则不能声称裸机闭环。
- 节点 ready/ready_with_warnings 判定与 capability 上报。

验收：在干净 Linux 环境只执行 Worker 安装注册命令；浏览器应用“标准编码节点”；观察 Pi 从下载、校验、安装、重启到 available；创建真实 Session，使用固定 Skill 和真实可用模型完成无副作用对话；制造坏 hash 和不兼容版本，证明 active 保留并回滚；离线节点上线后自动追赶。

### R3：Model provider + BYOK locator

**估时：64 至 96 小时，8 至 12 人日。**

交付物：

- model-provider revision、endpoint/模型清单/Agent 映射和 environment、worker-credential locator。
- Worker 本地 model-provider credential owner、SecretCodec、availability、轮换与脱敏。
- provider 配置 materializer、launch 时最小环境注入、模型能力探测。
- Preset 中 provider 条目、`credential_required` 引导、Web 本地配置跳转。
- Vault 只在已有真实 backend adapter 时加入本批；没有真实 adapter 时不开放。

验收：Server 数据库、wire fixture、日志和 report 中不存在 sentinel Secret；一个 Worker 用 environment locator，另一个用本地加密凭证，应用同一 provider revision 后均能探测模型；撤销或轮换 key 后新 Turn fail closed；Server 管理员无法读取 Worker Secret。

### 8.4 与七件套批次四的关系

**裁定：G51 不再作为七件套批次四中的独立实现，整体并入 R1；七件套批次四只剩 G54 Evals，并顺延到 R1 稳定后。**

理由：G54 依赖不可变 Skill revision，R1 正好把 G51 的领域裁定升级为通用资源底座。若先按旧 G51 单独建设 `skill.revision.sync`，随后再引入 Resource 会产生两次 wire、repository 和 Worker cache 迁移。G54 的原估时 48 至 76 小时保持，不计入本设计三批估时。

## 9. 风险与控制

| 风险 | 影响 | 控制与裁定 |
|---|---|---|
| Agent 包体和磁盘增长 | 多 runtime、多 revision 占满 Worker，导致 Session 或 SQLite 写失败 | manifest 声明 bytes；下载前预算；active/previous 强引用；无引用 LRU；磁盘不足 fail closed；节点页显示预算 |
| 分发风暴 | Preset 同时应用 N 节点，打满 Server、registry 或出口带宽 | Server 分批、每节点/全局并发上限、随机抖动、共享 blob 去重、支持内部 registry；安全更新也不绕过上限 |
| 离线节点追赶 | 上线后接收多次历史 revision，浪费下载并可能倒退 | 发送 desired snapshot 与最新锁定 revision；旧 Command 在 Worker 以 binding revision 判 stale；同 hash 不重下 |
| 供应链投毒 | 控制面可让所有节点执行恶意包 | 只允许固定官方 package 和 exact version；integrity/SHA-256；签名演进；Preset 高权限；安装审计；禁止任意 URL 和 shell |
| Preset 权限放大 | 一个模板可给大量节点安装软件、注入 Skill 或改变 provider | 实例 Preset 仅实例管理员；Project Preset 受 Worker manage；应用时重检 A3；autoApply 默认关；审计展开项 |
| Server 失陷后分发恶意静态内容 | Skill 虽不可执行，仍可提示 Agent 做危险操作 | Skill 只能收窄 capability；A3 与 approval 不变；Skill 内容可审查、hash 固定；危险工具仍走既有审批和 capability |
| Secret 泄漏 | provider key 进入 DB、wire、日志或 prompt | 禁止方案 A；locator only；Worker 本地解密；最小子进程环境；类型图扫描、sentinel fixture、日志脱敏 |
| runtime 更新中断任务 | 进程替换导致 Turn 丢失 | 活跃 Turn 不热切；排空后重启；restart_required 可见；失败恢复 previous；无法安全排空时等待管理员窗口 |
| connector 双重权威 | `allowedWorkerIds` 与 ResourceBinding 漂移 | ResourceBinding 为唯一分配权威；旧字段只做事务兼容投影，迁移后停止写入 |
| blob 与 SQLite 备份不一致 | revision 元数据存在但内容丢失 | DB 与 Server blob 目录同一恢复集；启动审计缺 blob 标 unavailable；不静默重建不同 hash |
| 跨平台原子语义差异 | Windows symlink/rename 与 Unix 不同 | pointer manifest 与同卷 rename adapter；R2 首个生产验收明确 Linux，其他平台逐一验证后再标支持 |
| 配置完成但模型不可用 | UI 把“文件已写”误报成 ready | ready 必须通过 Agent detect 和模型 inventory；credential_required、authentication-required、unavailable 分开显示 |

## 10. 不变量与明确不做

### 10.1 不变量

1. ResourceRevision 发布后不可变，修订必须生成新 revision。
2. ResourceBinding 是资源分配唯一权威，更新必须 requestId + fingerprint + CAS。
3. Server 不保存、解密或转发 Worker 的模型与连接器 Secret。
4. Worker 只从固定受信 artifact 或 Server 内容寻址 blob 获取内容，不接受控制面任意 URL。
5. transport ACK 不等于物化成功，也不得触发重新入队。
6. active revision 只有在 staging、完整性校验和 kind probe 成功后原子切换。
7. 运行中的 Invocation 固定资源 revision，不被新发布或 binding 更新热替换。
8. Preset 只展开 binding，不绕过逐资源 A3、兼容性和供应链检查。
9. ready 是能力事实，不是命令已接收或文件已下载。

### 10.2 为了轻量而不做

首版不做动态 ResourceKind 插件注册、任意 URL 下载、Skill marketplace、可执行 Skill、跨 Worker P2P 分发、Server 托管 Worker Secret、任意 Vault provider registry、运行中 Agent 热升级、跨平台同时首发、全局事务式多节点回滚，也不把 Worker 程序自身升级混成 `agent-runtime`。Worker 程序发布与节点资源分发共享 managed store 模式，但有独立权限、兼容矩阵和回滚生命周期。

## 11. 验收矩阵

| 范围 | 必须证明 |
|---|---|
| 合同 | ResourceRevision 不可变；Binding CAS 与 requestId 冲突；目标 Worker/Agent/Project 范围；connector 兼容迁移不产生双重权威 |
| Worker 文件系统 | 路径穿越、符号链接、hash 错、磁盘不足、并发同资源、staging 崩溃恢复、原子 active/previous、LRU 引用保护 |
| 可靠投递 | receipt 与 report 分离；断线重放同 commandId；纯 ACK 不重新入队；离线 desired reconcile；stale revision 不倒退 |
| 供应链 | 任意 URL/package spec 被拒；固定包名/版本/bin/integrity；坏 artifact 不激活；runtime 健康失败回滚 |
| BYOK | Secret 不进 Server DB、wire、Audit、日志和 capability snapshot；缺 key fail closed；环境和本地加密凭证两条路径；轮换后新 Turn 生效 |
| A3 | Preset 定义、应用、目标 Worker manage、执行 Worker use 与 Project/Session 权限求交；撤权后新 Invocation 不可用 |
| 真实浏览器 | 新节点出现、应用 Preset、逐阶段进度、失败重试、credential_required 引导、回滚、ready 后创建 Session |
| 真实裸机闭环 | 干净 Linux 安装 Worker并注册，控制面应用 Preset，Pi 安装并探测可用，固定 Skill 被实际注入，真实模型完成无副作用 Turn |
| 恢复 | Server/Worker 在下载、安装、激活、重启各阶段崩溃；重启后状态收敛，不重复副作用，不丢 active |

验收证据应包含固定 commit、Worker/Agent 版本、环境、命令、浏览器步骤、实际 report、失败注入和残余风险。模拟 Agent 可以覆盖故障矩阵，但不得替代“空 Worker 加入 -> Preset 应用 -> Pi 可用”的真实验收。

## 12. 最终裁定汇总

1. **资源抽象**：以不可变 ResourceRevision 描述内容，以 ResourceBinding 唯一表达资源到 Worker/Agent/Project 的分配，以 kind adapter 在 Worker 物化。
2. **连接器**：纳入统一 binding、Preset 和状态投影，保留现有 connector revision sync 作为执行 adapter，不重写成熟领域管道。
3. **Agent runtime**：复用现有固定官方版本 `agent install` 安装器，资源层只增加控制面目录、分配、状态、重启和回滚。
4. **凭证**：推荐引用式 locator，Worker 环境或 Vault 获取为标准路径，本地加密录入为 fallback，禁止 Server 保存后解密推送。
5. **快速路径**：bootstrap 仍需一次节点命令，注册后不再要求 SSH；管理员应用 Preset，Worker 自动物化、重启、探测并上报 ready。
6. **批次**：R1 10 至 14 人日，R2 13 至 18 人日，R3 8 至 12 人日，总计 31 至 44 人日；G51 并入 R1，G54 顺延。
