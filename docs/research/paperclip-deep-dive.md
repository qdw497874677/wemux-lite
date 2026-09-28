# Paperclip 基础设施机制深挖与可借鉴清单

> 研究对象：本地源码 `paperclip-upstream/paperclip/`
>
> 研究方法：只读核对源码、部署文档、测试与 GitHub Actions。本文聚焦 wemux-mini 可复用的基础设施机制，不重复已有概览性调研。

## 0. 结论摘要

Paperclip 最值得 wemux-mini 借鉴的不是某个 Tailscale 命令，而是将网络可达性、身份认证、发布制品、持久队列和低信任执行都建模成独立且可组合的控制面。其 Tailnet 支持分成两条路径：主服务直接绑定 Tailscale IP，以及独立低权限 broker 将 loopback 工作负载以 Tailnet 私有 HTTPS 暴露。前者适合 wemux-mini 当前 Server node，后者更适合未来需要暴露 Worker 预览服务时采用。

优先建议是：先补齐 bind 与 auth 的正交配置和 fail-closed 规则，再把 worker tgz 做成可回滚的不可变制品，随后为 M8 Routines 建持久触发收据、原子签出和孤儿恢复。PGlite 或真实嵌入式 PostgreSQL 暂不建议替换现有 `node:sqlite`，除非并发调度、行锁、JSONB 查询和外部 PostgreSQL 同构性成为明确瓶颈。

## 1. Tailnet 与网络支持

### 1.1 bind 与 auth 是两个正交维度

Paperclip 没有把 “Tailnet” 当作认证方式。它把配置拆成：

1. 认证与暴露级别：`local_trusted`，或 `authenticated + private/public`。
2. 监听可达性：`loopback | lan | tailnet | custom`。

`local_trusted` 只允许 loopback 且免登录；`authenticated/private` 要求登录，可搭配四种 bind；`authenticated/public` 要求显式公网 URL，并启用更严格的公网默认值。对应定义与推荐组合见 `paperclip/doc/DEPLOYMENT-MODES.md:8-58`。

这不是文档约定而已。服务启动时会拒绝 `local_trusted + 非 loopback`，也会拒绝 `local_trusted + 非 private`，最终才把解析后的 host 传给监听器，见 `paperclip/server/src/index.ts:654-662,688-738,931-996`。认证侧单独派生 trusted origins，将 public base URL、allowed hostnames、协议和端口组合交给 Better Auth，见 `paperclip/server/src/auth/better-auth.ts:184-210,241-283`。

配置来源也分层：环境变量覆盖配置文件，再回落到安全默认值；bind host、public URL 和认证基址分别解析，见 `paperclip/server/src/config.ts:170-225`。

**与 wemux-mini 对照**

- 已有：register/start 自动预检、Tailscale 诊断、`GET /api/cluster/tailnet` 自检、`--prefer tailnet` 多地址轮换。
- 缺少或需要明确化：Server 的监听范围与认证策略是否是两个显式维度；非 loopback 是否一律强制认证；浏览器 origin/hostname 是否独立于节点地址选择管理；public 与 private 是否有不同的限流和 cookie 默认值。
- 当前 `--prefer tailnet` 解决的是客户端选址。Paperclip 额外解决了服务端“允许监听到哪里”和“监听后必须采用何种认证”的策略闭环。

**可借鉴判定：借模式，少量搬代码**

- 借模式：定义 `bindMode=loopback|lan|tailnet|custom` 与 `authMode=local_trusted|authenticated`，再加 `exposure=private|public`。
- 可搬代码思路：启动期不变量校验、配置优先级、allowed hostnames 到 trusted origins 的派生测试。
- 不建议直接搬 Better Auth 绑定代码，因为 wemux-mini 的 HTTP/auth 栈不同。

**估时：2.5 至 4 人日**，含配置迁移、启动校验、API 自检字段和测试。

### 1.2 onboarding 的 Tailnet 预检与安全降级

交互 onboarding 把本机可信模式标为首次运行推荐，并提供 Tailnet 一等选项。Tailnet 文案明确是“使用本机检测到的 Tailscale 地址进行私有认证访问”，见 `paperclip/cli/src/prompts/server.ts:7-8,21-45,81-108`。

检测逻辑见 `paperclip/cli/src/config/server-bind.ts:14-44,46-75,121-132`：

1. 优先读取 `PAPERCLIP_TAILNET_BIND_HOST`。
2. 否则以 `execFileSync` 执行 `tailscale ip -4`，超时 3000 ms，不经过 shell。
3. 取第一个非空 IPv4。
4. 检测失败时实际 host 回退 `127.0.0.1`，但配置仍保留 `bind=tailnet`，方便 Tailscale 恢复后重新解析。
5. 非 loopback 预设自动搭配 `authenticated/private`。

测试证明了有地址时保存 `100.64.0.8`，无 Tailscale 命令时保存 tailnet 语义但监听 loopback，见 `paperclip/cli/src/__tests__/onboard.test.ts:257-286`。

这个策略的重要点是 fail closed：检测失败不会退化为 `0.0.0.0`。但它只检测 IP，不自动推导 MagicDNS 名称。若浏览器通过 MagicDNS 访问，名称仍需进入 allowed hostnames 或 trusted origins。

**与 wemux-mini 对照**

- 已有：register/start 的预检与诊断覆盖面比 Paperclip 的单次 `tailscale ip -4` 更完整，且有运行时 tailnet API 自检。
- 可补：把“检测失败后的监听行为”固定成 loopback，并在 API 中同时返回 requested bind mode 与 effective bind host，避免配置语义与实际监听不一致时难以诊断。
- 可补：把 MagicDNS hostname、Tailscale IPv4、节点在线状态、DNS 可解析性拆成独立检查项，不要用单一 tailnet healthy 布尔值替代。

**可借鉴判定：借模式**。wemux-mini 已有更丰富诊断，无需搬检测函数；应搬的是 requested/effective 双状态和 fail-closed 降级。

**估时：1 至 1.5 人日**。

### 1.3 `tailscale-https-broker` 的职责与安全边界

`paperclip/packages/tailscale-https-broker/` 不是证书签发器，也不是 Funnel 管理器。它是一个独立、低权限、仅限本机 Unix socket 调用的 Tailscale Serve 控制 broker，用于把受管 workspace 的 loopback 服务映射为 Tailnet 内私有 HTTPS。其明确禁止证书管理、Funnel、Tailscale Services、`serve reset`、任意 target、非 loopback backend、443 和范围外端口，见 `paperclip/packages/tailscale-https-broker/README.md:1-43`。

HTTPS 证书不是 Paperclip 下载或保存的。broker 只调用 `tailscale serve` 建立 HTTPS 映射，TLS 与 `*.ts.net` 节点名称由 Tailscale Serve 和 tailnet 控制面处理。换言之：

- broker 管授权、端口和 Serve 配置事务。
- Tailscale 管节点身份、MagicDNS 名称、Tailnet TLS 终止。
- 该 HTTPS 默认只在 tailnet 内可达，不等于公网 webhook。UI 也明确提醒 Serve 私有、外部应用需要 Funnel 或其他公网 HTTPS，见 `paperclip/ui/src/lib/webhook-url-warning.ts:1-12,24-35` 与 `paperclip/ui/src/components/routine-triggers/WebhookUrlWarning.tsx:8-18`。

核心防护包括：

- 进程隔离：独立 `paperclip-tsbroker` 账户拥有 Tailscale operator 权限，Paperclip 主进程不拥有，见 `paperclip/packages/tailscale-https-broker/README.md:55-96`。
- 本机身份：每连接读取 Linux `SO_PEERCRED`，按精确 UID 与主 GID 授权，不信任调用者自报身份，见 `paperclip/packages/tailscale-https-broker/src/authorization.ts:1-86`。
- 租约能力：handle 是 256-bit base64url 随机值，删除时同时核对 handle、runtimeId、UID/GID，并做常量时间比较。
- 协议限流：4 字节长度前缀单帧、请求响应大小限制、全局和每 UID 连接上限、5 秒连接期限、socket 权限 `0660`，见 `paperclip/packages/tailscale-https-broker/src/socket-server.ts:1-24,26-87,89-172`。
- 端口白名单：app 仅 `42000-42999`，HMR 仅 `52000-52999`，443 永久保护，见 `paperclip/packages/tailscale-https-broker/src/port-policy.ts:1-49`。
- listener 证明：expose 前从 `/proc` 验证端口确实仅绑定 loopback、属于受管 UID，并记录 socket inode，防止同 UID 进程在检查后替换 listener，见 `paperclip/packages/tailscale-https-broker/src/broker-core.ts:112-181,228-320`。
- Serve 事务：只接受精确的 `HTTPS / -> http://127.0.0.1:<同端口>`；变更前后比较 443、保护端口和完整 diff，未知结构直接拒绝，见 `paperclip/packages/tailscale-https-broker/src/serve-config.ts:45-194` 与 `paperclip/packages/tailscale-https-broker/src/broker-core.ts:423-465,687-716`。
- 命令执行：`spawnSync`、`shell:false`、最小 PATH/HOME、固定 cwd、256 KiB 输出上限、10 秒超时、最低 Tailscale 1.80，见 `paperclip/packages/tailscale-https-broker/src/tailscale-cli.ts:1-66`。
- 故障处理：部分失败先精确补偿；无法证明清理完成时把端口标为 `cleanup_pending`，禁止复用，并写追加审计日志，见 `paperclip/packages/tailscale-https-broker/README.md:181-196,225-236`。
- doctor：只读检查 CLI 版本、Serve 状态、主 443 路由、registry 路径安全和节点身份，核心项失败退出 1，见 `paperclip/packages/tailscale-https-broker/src/main.ts:24-88`。

**与 wemux-mini 对照**

- 当前 Server/Worker 的 Tailnet 连接不需要 broker。直接通过 Tailscale IP 访问固定 API 时，已有 `--prefer tailnet` 更简单。
- 如果未来 Worker 要把任意 Agent 预览端口暴露给 tailnet，直接赋予 Worker `tailscale set --operator` 或任意 `tailscale serve` 权限会扩大本机横向暴露面。
- 届时缺少的关键能力不是 HTTPS 证书下载，而是独立 operator、peer credentials、专用端口池、loopback listener 所有权验证、租约、事务后验检查和 cleanup quarantine。

**可借鉴判定：当前借模式，未来可搬独立包架构**

- 当前不适用：固定 Server API 没必要增加 broker 复杂度。
- 未来适用：Worker 托管预览、IDE、HMR 或临时 Web 服务时，建议参考其安全边界重新实现，不宜原样搬包，因为 Paperclip broker 强依赖 Linux `/proc`、`SO_PEERCRED`、N-API 和固定端口布局。

**估时：设计 2 人日；Linux MVP 6 至 9 人日；含恢复、审计和对抗测试的生产版 12 至 18 人日**。

## 2. 安装与发布工程

### 2.1 `install.sh` 是 bootstrap，不是完整安装器

`paperclip/scripts/install.sh:4-15,163-210` 固定最低 Node 24.11.0，只支持 macOS/Linux、x64/arm64，并区分交互与 `--no-prompt`。Node 引导脚本采用固定 commit、固定 SHA-256、HTTPS/TLS 1.2、shebang 与 `bash -n` 校验，见 `paperclip/scripts/install.sh:249-305`。检测到 nvm/asdf 时拒绝混用系统 bootstrap；从管道执行且 Node 缺失时，也拒绝自动提权安装，要求先下载审阅脚本，见 `paperclip/scripts/install.sh:276-360`。

真正安装由 npm 上的管理 CLI 完成。脚本创建临时 `0600` npmrc，固定 public registry，再调用精确版本的 `paperclipai install`；服务安装和 onboarding 也交给同版本 CLI，见 `paperclip/scripts/install.sh:363-409`。

管理 CLI 的 store 模型见 `paperclip/cli/src/install-store.ts:14-39,247-348,381-425`：版本 payload 进入 `cli/installs/`，`current` 是原子 rename 的相对 symlink，manifest 保存 current 与 previous，shim 固定 Node 可执行文件和 bin PATH。npm payload 先在 staging 安装并执行 `--version` 冒烟，成功后才 rename，见 `paperclip/cli/src/commands/install.ts:175-229`。

服务层抽象 systemd/launchd，并始终指向稳定 shim，而不是某个版本目录，见 `paperclip/cli/src/services/service-manager.ts:127-177,204-260`。升级后轮询 `/api/health` 并校验目标版本，失败自动翻回旧 symlink；同时明确数据库 migration 不会随二进制回滚，见 `paperclip/cli/src/commands/update.ts:128-180,219-272`。

**与 wemux-mini 对照及 worker tgz 启示**

- worker tgz 不应由 shell 脚本直接覆盖当前目录。
- 建议布局：`worker/installs/<version-or-sha>/`、原子 `current`、manifest 中 current/previous、稳定 supervisor shim。
- 下载流程应为 immutable manifest -> tgz staging -> SHA-256/size/platform 校验 -> clean-install smoke -> 原子激活 -> 服务健康和协议版本检查 -> 失败自动回滚。
- manifest 至少包含 schemaVersion、workerVersion、source SHA、channel、sha256、size、platform、arch、entrypoint、Server/Worker protocol compatibility。
- 状态和二进制必须分别回滚。任务数据库或协议 migration 不应被 current symlink 回滚掩盖。

**可借鉴判定：借模式，部分搬结构**。可直接复用 staging、原子 current、previous、稳定 shim、健康失败回滚的结构思想；不建议搬 Paperclip 的 npm/Node bootstrap 细节。

**估时：5 至 8 人日**，含 manifest、下载校验、激活锁、服务健康、回滚和故障测试。

### 2.2 四通道发布与真实 nightly 冒烟

`paperclip/scripts/release.sh:20-85,175-235` 定义 stable、beta、nightly、canary 的 CalVer 和 dist-tag，并限制晋级来源：canary 来自 master；nightly 必须来自已发布 canary 的同一提交；beta 通常来自 nightly；stable 来自 beta。

发布构建、版本重写、串行 npm publish、registry 可见性等待和 dist-tag 完整性验证见 `paperclip/scripts/release.sh:265-309,311-430`。关键思想是先发布不可变制品并确认可见，再移动通道指针。

自动化链条见 `paperclip/.github/workflows/release.yml:384-482,484-712,713-855,1051-1135,1284-1353`：

- master push 产出 canary。
- nightly 每日选择最近已发布 canary 的精确版本，先跑 smoke，绿色后从同一 SHA 晋级。
- beta 人工审批。
- stable 固定 immutable SHA，默认要求 beta 浸泡至少 3 天，绕过必须书面说明。

nightly 冒烟不是单元测试替代品，而是对真实发布制品做两条端到端验证：Ubuntu user-systemd 服务安装，以及 Docker onboarding + Chrome/Playwright 浏览器流程，见 `paperclip/.github/workflows/release-smoke.yml:40-190`。服务脚本要求真实 npm artifact 生成 shim、systemd unit active、`/api/health` 确由该服务提供，见 `paperclip/scripts/service-onboard-smoke.sh:4-27,41-100`。

Docker 采用 amd64/arm64 各自 push digest，再合并 manifest，且 canary 可变标签以 npm 当前 canary 为权威收敛，避免并发 job 后完成者把通道倒退，见 `paperclip/.github/workflows/docker.yml:187-240,272-387,389-444`。

**与 wemux-mini 对照及 worker tgz 启示**

- worker tgz 应先发布 immutable SHA/版本对象，再移动 `canary/nightly/beta/stable` manifest 指针。
- nightly 不重新构建 worker，而应复用已通过 canary 的同一 tgz 字节或 digest。
- smoke 应至少覆盖：全新 Server 拉取 worker、注册、启动、协议握手、执行一个真实无副作用任务、重启服务后恢复、自动回滚。
- 可变 channel 更新需要 compare-and-set 或“读取当前权威版本后收敛”，避免并发发布倒退。
- Paperclip 的 `paperclip-runner.tgz` 目前主要是 CI eval 制品，不在正式 release package manifest 中，见 `paperclip/.github/workflows/runner-protocol-live-evals.yml:376-395,590-595` 与 `paperclip/scripts/release-package-manifest.json:1-170`。因此可借鉴的是主发布体系，而不是当前 runner tgz 的成熟度。

**可借鉴判定：借模式**。四通道可按团队规模先压缩为 canary/stable，但 immutable 制品、同字节晋级和真实安装 smoke 应保留。

**估时：6 至 10 人日**，若先做 canary/stable 两通道则 3 至 5 人日。

## 3. 自托管数据边界

### 3.1 Telemetry 默认开启，关闭必须显式

Telemetry 配置优先级见 `paperclip/packages/shared/src/telemetry/config.ts:62-85`：`PAPERCLIP_TELEMETRY_DISABLED=1`、`DO_NOT_TRACK=1`、CI 环境或文件配置 `enabled=false` 会关闭，否则默认 `enabled=true`。Server 和 CLI 都走同一解析器，见 `paperclip/server/src/telemetry.ts:12-25` 与 `paperclip/cli/src/telemetry.ts:16-32`。

客户端内置两个公网 ingest endpoint，50 条触发 flush，5 秒超时；可重试状态最多 5 次，队列仅在内存，见 `paperclip/packages/shared/src/telemetry/client.ts:14-22,284-320,401-442`。disabled client 的 enqueue/flush 立即返回，因此不会创建状态或发网，见 `paperclip/packages/shared/src/telemetry/client.ts:143-174`。

本地 `state.json` 保存 installId、32 字节随机 salt、创建时间和首见版本，见 `paperclip/packages/shared/src/telemetry/state.ts:6-30`。私有引用以安装级 salt 做 SHA-256 后截断为 16 hex，属于安装内稳定的可关联标识，不应称为完全匿名，见 `paperclip/packages/shared/src/telemetry/client.ts:476-488`。

代码组织把评审入口分成五层：generated event contract、typed emitter、generic client、调用点、retention，见 `paperclip/packages/shared/src/telemetry/README.md:8-34,185-198`。README 禁止发送 PII、秘密、私有路径、prompt 和模型输出，但 generic client 没有通用敏感字段扫描；动态插件入口也需单独审计，见 `paperclip/packages/shared/src/telemetry/client.ts:114-140`。

Paperclip 还明确区分三条路径：

1. 产品 Telemetry：默认开启并外发。
2. OpenTelemetry/Sentry：显式 opt-in；无 OTLP endpoint 时不加载 SDK，见 `paperclip/doc/observability.md:1-25`。
3. Run-log：写本地 PostgreSQL `heartbeat_run_events`，不要求外部 endpoint，也不会自动转成前两类导出，见 `paperclip/doc/run-log-events.md:1-35`。

**与 wemux-mini 对照**

- 自托管产品需要在文档和代码中列清所有外发路径，不能只提供一个“telemetry off”开关。
- 建议建立同样的三路径清单：产品指标、可观测性导出、本地运行审计，并分别评审默认值、endpoint、字段、保留期和关闭证明。
- 若 wemux-mini 当前无默认外发，不应为了对齐而引入；可借鉴的是事件契约与评审分层。

**可借鉴判定：借模式，不搬默认开启策略**。自托管 Agent 平台更适合默认关闭或 onboarding 明示选择。

**估时：2 至 3 人日**，用于数据流清单、统一开关语义、事件契约和测试；不含新增采集后端。

### 3.2 PGlite 已被真实嵌入式 PostgreSQL 替代

当前源码的正式模式只有 `postgres | embedded-postgres`，旧 `pglite` 只是兼容配置迁移别名，见 `paperclip/packages/db/src/runtime-config.ts:12-38,105-133,185-235`。默认模式会启动持久化的真实 PostgreSQL cluster，见 `paperclip/packages/db/src/migration-runtime.ts:80-97,139-180`。依赖中也只有 embedded-postgres，没有 PGlite，见 `paperclip/packages/db/package.json:37-54`。

仍有部分文档写 PGlite，属于文档漂移。当前部署事实应以 `paperclip/docs/deploy/database.md:6-25,82-90` 和上述代码为准。

**与 wemux-mini 的 `node:sqlite` 对照**

- `node:sqlite` 优势：Node 内建、单文件、备份简单、无子进程和端口，适合单 Server node、低到中等并发、明确双宿主边界。
- embedded PostgreSQL 优势：与生产外部 PostgreSQL 同构，支持成熟行锁、并发事务、JSONB 和复杂调度查询。
- 代价：native 二进制、子进程生命周期、端口、共享内存、升级和恢复复杂度明显上升。
- Paperclip 自己只在窄化的 Codex 本地状态维护中使用 `node:sqlite`，并对未知 trigger/级联 fail closed，见 `paperclip/server/src/services/native-runtime/native-session-executor.ts:2297-2343`；主业务库仍是 PostgreSQL。

**可借鉴判定：当前不适用迁移，借鉴升级触发条件**

只有在以下条件出现时再评估 PostgreSQL：多 Server 实例共同签出任务；SQLite 写锁成为可测瓶颈；M8 需要大量并发队列和行级锁；JSONB/复杂索引成为核心；需要本地与托管数据库同构。否则继续 `node:sqlite` 更符合 wemux-mini 的小型自托管定位。

**估时：当前 0.5 人日记录 ADR；若未来迁移，至少 15 至 25 人日**，不含生产迁移演练。

## 4. Heartbeat 持久队列与 M8 Routines

Paperclip 使用两层持久记录：`heartbeat_runs` 是执行状态机，`agent_wakeup_requests` 是输入收据和延迟队列。schema 分别见 `paperclip/packages/db/src/schema/heartbeat_runs.ts:20-155` 与 `paperclip/packages/db/src/schema/agent_wakeup_requests.ts:15-88`。

### 4.1 coalescing 不是简单去重

wake admission 会对同 agent、同 issue 的输入决定 coalesce、defer 或 proceed，见 `paperclip/server/src/modules/wake-queue/application/use-cases.ts:780-929`：

- 可安全合并时，把 incoming context 合入 queued/running run，并写 durable `coalesced` receipt。
- 手动新执行、running 上的新评论、`forceFreshSession`、interaction decision、不同 durable actor 等情况形成新的 turn 边界，进入 deferred wake。
- 后续同 actor、同 issue 输入可继续合并到 deferred wake，增加 `coalescedCount`。
- 合并 run 与插入 receipt 在同一事务；deferred merge 使用状态 CAS，冲突则整体回滚，见 `paperclip/server/src/modules/wake-queue/adapters/postgres.ts:910-990`。

`mergeCoalescedContextSnapshot` 会去重评论 ID、让 `forceFreshSession` 具有 sticky OR 语义，并禁止 incoming wake 自行铸造外部聊天授权证明，见 `paperclip/server/src/services/heartbeat.ts:7253-7335`。僵尸 running run 会被排除，避免新输入更新其 `updatedAt` 后不断给死 run 续命，见 `paperclip/server/src/services/heartbeat.ts:5694-5705`。

### 4.2 原子签出依赖数据库 CAS 与 scope 行锁

`claimQueuedRun` 在签出前重新检查 agent 可执行性、预算、依赖、stale queue 和 native finalization，见 `paperclip/server/src/services/heartbeat.ts:17157-17193`。issue run 随后：

1. 对 company-scoped issue 执行 `FOR UPDATE`。
2. 检查旧 `executionRunId`、环境 lease 和 finalization 屏障。
3. 执行 `UPDATE heartbeat_runs ... WHERE status='queued' RETURNING`。
4. 零行表示输掉竞争。
5. 成功后在同一事务写 `issues.executionRunId`。

关键实现见 `paperclip/server/src/services/heartbeat.ts:17325-17387,17543-17563,17720-17790`。comment queue 使用固定锁顺序 issue -> wake -> run，并校验 wake/run 双向关联，见 `paperclip/server/src/services/heartbeat.ts:17400-17444`。

它不是 `SKIP LOCKED` worker queue。进程内 agent lock 只降低竞争，真正的跨实例保证来自 issue 行锁和 queued -> running CAS。

### 4.3 孤儿恢复采用 fail-closed 所有权模型

恢复顺序先处理可恢复的 native finalization，再扫描 running，见 `paperclip/server/src/services/heartbeat.ts:18841-18972`。合法 owner 包括当前进程执行 map、native coordinator lease 和 live controller。PID 或 native owner 仍存活但归属无法证明时，系统保持 running/block，不杀、不重试，避免重复 provider/tool 执行，见 `paperclip/server/src/services/heartbeat.ts:19031-19218`。

确认 owner 丢失且超过阈值后，系统以 running -> failed CAS 写 `process_lost`，按规则最多重试一次，释放 issue 和环境资源，再推进后续队列，见 `paperclip/server/src/services/heartbeat.ts:19220-19327`。终态 run 遗留的 active lease 会转为 `pending_cleanup` 并重试清理，见 `paperclip/server/src/services/heartbeat.ts:19337-19385`。queued/deferred work 在启动和周期任务中重新驱动，见 `paperclip/server/src/services/heartbeat.ts:19388-19489`、`paperclip/server/src/index.ts:1486-1508,1757-1766`。

### 4.4 对 M8 Routines 的适配

Routines schema 已包含 `concurrencyPolicy=coalesce_if_active`、catch-up policy、immutable revision snapshot、idempotency、dispatch fingerprint、linked issue 和 `coalescedIntoRunId`，见 `paperclip/packages/db/src/schema/routines.ts:23-104,144-179`。这与 wemux-mini 的受控自动化高度相关。

**与 wemux-mini 对照**

建议 M8 至少保留：

- trigger receipt 唯一键和 immutable routine revision。
- coalesce key：tenant + routineId + resolved variables/dispatch fingerprint，不能只按 routineId。
- 不可合并类别：人工新执行、审批/interaction、不同 actor、强制新 session、不同变量指纹。
- queued -> running 单语句 CAS，并在同一事务绑定 execution scope lock。
- owner identity/lease、last progress、terminal/finalization barrier。
- startup recovery、周期 stale reaper、queued resume。
- 外部副作用采用 at-least-once + idempotency key/outbox，不宣称数据库能保证 exactly-once。
- ownership unverified 是独立人工处置状态，不要看到旧 PID 就直接重跑或杀进程。

若 wemux-mini 没有 issue 实体，可抽象 `execution_lock(scope_key, run_id, lease_state, finalization_state)`。不要只搬 `heartbeat_runs` 表，因为安全性还依赖 scope lock、wake receipt、资源清理和 finalization 屏障。

**可借鉴判定：借模式，不搬 2 万行 heartbeat 实现**。先实现最小持久队列协议，再按实际规模决定 SQLite 的 `BEGIN IMMEDIATE`/条件更新是否足够；若未来多 Server 实例并发签出，再评估 PostgreSQL。

**估时：M8 队列内核 8 至 12 人日；含 outbox、恢复矩阵和并发故障测试 15 至 22 人日**。

## 5. 安全细节

### 5.1 secrets vault 与 `enc:v2` 对照

Paperclip 本地 provider 使用 `local_encrypted_v1` envelope，字段为 base64 的 iv、tag、ciphertext；算法是 AES-256-GCM，每条秘密使用随机 12-byte IV，见 `paperclip/server/src/secrets/local-encrypted-provider.ts:14-19,190-238`。

主密钥优先来自 `PAPERCLIP_SECRETS_MASTER_KEY`，否则从文件加载或生成 32 随机字节并以 `0600` 写入，见 `paperclip/server/src/secrets/local-encrypted-provider.ts:21-87,101-188`。CLI 也可提前创建 key file，见 `paperclip/cli/src/config/secrets-key.ts:6-50`。恢复要求数据库和同一主密钥共同备份；明文注入 agent/SSH/sandbox/HTTP consumer 后，vault 不再保护消费进程，见 `paperclip/docs/deploy/secrets.md:6-25,171-220`。

值得注意的缺口：

- envelope 没有 `kid`/key version，轮换和多密钥解密不方便。
- 未使用 AAD，密文未与 companyId、secretId、version 等上下文绑定。
- 结构层只检查字符串，未显式严格校验 base64、IV/tag 长度和密文大小。
- `company_secret_versions` 额外保存明文的无盐 SHA-256 指纹并建索引，泄露相等性，对低熵秘密可能被离线猜测，见 `paperclip/packages/db/src/schema/company_secret_versions.ts:5-28`。

**与 wemux-mini `enc:v2` 对照**

应逐项确认 `enc:v2` 是否具备：版本探测与未知版本 fail closed；随机 nonce 和严格长度；AAD 绑定记录上下文；`kid` 与多密钥轮换；严格 base64url 和大小上限；认证失败统一错误；迁移的双读单写策略；数据库与 key 联合恢复；避免无盐明文指纹；日志和 Agent env 的明文生命周期控制。

**可借鉴判定：借审计清单，不搬实现**。若 `enc:v2` 已有 AAD、kid 和严格解析，则整体优于 Paperclip v1；Paperclip 的价值主要是 provider 抽象、版本治理和部署恢复文档。

**估时：1.5 至 2.5 人日**完成字节级对照、负面测试补齐和 ADR；若缺 kid/AAD，升级约 4 至 7 人日。

### 5.2 威胁建模方法

`paperclip/doc/connections/SECURITY-THREAT-MODEL.md:20-61` 先定义资产和权威源，再规定秘密绝不能出现的位置，并要求每次执行重新检查连接、secret version、策略、资源过滤和 company ownership。plugin worker、外部 provider、MCP、webhook 和 relay 都在信任边界外，见 `paperclip/doc/connections/SECURITY-THREAT-MODEL.md:78-111`。

其最可借鉴之处是把威胁模型落到可执行负面测试：跨公司 IDOR、越权工具、空资源过滤、撤销后的排队任务、OAuth state/redirect、webhook 签名与重放，以及 API/日志/导出不得含原始秘密，见 `paperclip/doc/connections/SECURITY-THREAT-MODEL.md:180-204,261-309`。

**与 wemux-mini 对照**

wemux-mini 的 Server/Worker 双宿主尤其适合采用同样模板：资产 -> 权威源 -> 信任边界 -> admission 检查 -> execution-time 复检 -> 禁止落点 -> 负面测试。Worker 已注册不等于其输出可信，tailnet 成员资格也不等于免鉴权。

**可借鉴判定：直接借模式**，并将现有安全说明改写成测试矩阵。

**估时：2 至 3 人日**形成首版威胁模型和测试缺口清单。

### 5.3 低信任预设

`low_trust_review` 面向含 prompt injection 风险的自动化输入。多来源策略取交集，要求具体 company-local project/root issue/issue scope；禁止低信任 agent 修改 agent 配置、指令包和 company skill；默认禁止向高信任 parent 写自由文本；托管运行必须使用 sandbox + isolated workspace；secret refs 只能来自明确允许的 binding ids，见 `paperclip/doc/LOW-TRUST-PRESETS.md:1-68`。

resolver 对跨公司来源直接 deny；任一来源要求 low trust 时有效策略即为 low trust；缺少具体 scope 时 fail closed，见 `paperclip/server/src/services/trust-preset-resolver.ts:280-339`。运行时还检查 sandbox driver、isolated workspace、issue scope 和 `runtime.manage` tool class，见 `paperclip/server/src/services/low-trust-runtime-containment.ts:9-115`。Heartbeat 投影 env 时关闭 trusted env，并限制 secret binding，见 `paperclip/server/src/services/heartbeat.ts:1568-1590`。

**与 wemux-mini 对照**

M8 Routines 会把定时器、webhook、外部 issue 或消息转成 Agent 输入，这正是 prompt injection 的高风险入口。建议预设至少控制：允许的 workspace、tool classes、secret binding IDs、网络目标、可写 issue/project 范围、向高信任上下文提升的输出类型，以及 runtime 管理权限。

**可借鉴判定：借模式，优先于开放任意 webhook 自动执行**。

**估时：策略模型与 admission 3 至 5 人日；加 sandbox、secret 投影和端到端测试 8 至 14 人日**。

## 6. 可借鉴机制清单

| 机制 | 判定 | 建议落点 | 估时 |
|---|---|---|---:|
| bind/auth/exposure 正交模型与启动不变量 | 借模式 | Server 配置、启动校验、tailnet API | 2.5 至 4 人日 |
| Tailnet 检测失败回退 loopback，区分 requested/effective | 借模式 | register/start 与诊断 API | 1 至 1.5 人日 |
| 独立 Tailscale Serve broker | 未来搬架构 | Worker 预览服务控制面 | 12 至 18 人日 |
| managed payload store、原子 current、previous、稳定 shim | 借模式并部分搬结构 | worker tgz 安装器 | 5 至 8 人日 |
| immutable 制品与 channel 晋级 | 借模式 | worker 发布流水线 | 3 至 10 人日 |
| 真实服务安装、协议和浏览器 smoke | 借模式 | nightly gate | 3 至 5 人日 |
| 三路径数据边界评审 | 借模式 | telemetry/observability/run-log 文档与测试 | 2 至 3 人日 |
| embedded PostgreSQL | 当前不适用 | 保留 ADR 和迁移触发条件 | 0.5 人日 |
| durable receipt + coalesce/defer/proceed | 借模式 | M8 Routines admission | 4 至 6 人日 |
| scope lock + queued->running CAS | 借模式 | M8 executor | 3 至 5 人日 |
| ownership-unverified 孤儿恢复 | 借模式 | Worker run recovery | 4 至 7 人日 |
| vault envelope 对照清单 | 借审计方法 | `enc:v2` ADR 与负面测试 | 1.5 至 7 人日 |
| connection threat model 测试矩阵 | 直接借模式 | Server/Worker 安全文档 | 2 至 3 人日 |
| low-trust preset | 借模式 | M8 webhook/外部输入 | 8 至 14 人日 |

## 7. Top 5 借鉴优先级

1. **bind/auth/exposure 正交化与 fail-closed 启动校验**，2.5 至 4 人日。它直接补齐已有 Tailnet 选址能力之外的服务端安全模型，收益高、改动可控。
2. **worker tgz 的 managed store、不可变 manifest、原子激活与健康失败回滚**，5 至 8 人日。它把分发从“下载压缩包”升级为可恢复的产品能力。
3. **M8 的 durable trigger receipt、coalesce fingerprint、scope lock 与 queued -> running CAS**，8 至 12 人日。它是受控自动化不重复执行、不丢触发的最小内核。
4. **启动与周期孤儿恢复，采用 ownership-unverified fail-closed 状态**，4 至 7 人日。它避免 Server/Worker 重启后重复执行 Agent 外部副作用。
5. **低信任 Routine 预设和连接威胁模型负面测试矩阵**，8 至 14 人日。应在 webhook 和外部内容自动唤醒 Agent 之前完成，而不是上线后补救。

**Top 5 总估时：约 27.5 至 45 人日。** 若由一名工程师串行实施并包含评审、文档、故障注入和发布观察，建议规划 7 至 11 周。独立 Tailscale HTTPS broker 不进入当前 Top 5，等 Worker 需要暴露动态预览端口时再启动，预计另需 12 至 18 人日。
