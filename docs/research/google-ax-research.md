# Google AX 调研报告

> 调研日期：2026-09-27。代码快照：`/opt/data/profiles/hacker/workspace/project/google-ax-upstream`（main 分支 tarball，65 文件 / 512KB，Apache-2.0）。
> 方法：GitHub API 元数据 + codeload tarball 下载后通读 README/DESIGN/docs 与关键源码；辅以 InfoWorld / dev.to / HN 公开报道。所有源码断言均给出本地路径。

## 1. 指向确认：「Google AX」是什么

搜索确认的候选（按可能性排序）：

| 候选 | 说明 | 判定 |
|---|---|---|
| **google/ax — Agent Executor（AX）** | Google 开源的分布式 agent 编排运行时（Go，Apache-2.0），2026 年发布，HN 热榜 | ✅ **最可能，本文重点** |
| Google Antigravity | agentic IDE（2025-11 发布），与 AX 相关：AX 默认 runner 内置 Antigravity agent 做 workspace 引导 | 相关联但不是「AX」本体 |
| agentexperience.dev 的 AX | 社区「Agent Experience」概念（给 agent 用的网站 UX 标准） | 概念层，非 Google 产品 |
| Google ADK（Agent Development Kit） | 2025 Cloud Next 发布的 Python agent 开发框架 | 名字不含 AX，非目标 |
| A2A / Agent Explorer 工具 | Agent2Agent 协议及第三方 explorer（agent-explorer.com 等） | 协议/第三方工具，非「Google AX」 |
| ax.ai 的 Ax | 同名开源 agent 框架（非 Google） | 排除，注意别混淆 |

确认依据：多源（Techzine、InfoWorld、dev.to、agenticaihype.substack）一致指向 `github.com/google/ax`，"AX, short for Agent Executor"；与用户上下文（AI agent 集群平台调研）完全对口。

## 2. 它是什么

- **定位**：Google 官方描述为 "Google's open agentic orchestration runtime"——"high-throughput, declarative orchestrator to run billions of autonomous agent workloads in a cluster"。自比 Kubernetes：`ax apply -f task.yaml` → `ax get tasks` → `ax watch` → `ax ssh`。
- **时间线**：repo 创建 2026-03-30（GitHub API `created_at`）；InfoWorld 报道 2026-05-25；大规模公开曝光是 2026-09 下旬（HN thread id=49780797，2026-09-22 前后，数天内从 ~2k 涨到 12k stars）。当前 **11,949 stars**。README 明确警告：早期活跃开发，稳定版前会有重大破坏性变更，**暂时暂停接受外部 PR**（只收 Issue）。
- **开源**：是。Go 语言，**Apache-2.0**，github.com/google/ax，homepage https://agentexecutor.io 。
- **与 Google 生态关系**：
  - 跑在 **Agent Substrate**（github.com/agent-substrate/substrate）之上——Google 同期发布的沙箱化 actor 计算层（rakyll 2026-09 中旬宣布），负责 actor 创建/激活/checkpoint；AX 只做编排层。
  - **Gemini**：默认 Model 是 gemini-3.8-flash；workspace goal 引导默认用 **Antigravity** agent（需 GEMINI_API_KEY）。
  - **A2A**：代码内无 A2A 集成（grep 0 命中）；InfoWorld 报道 Google 的整体战略是把 AX 作为 infra 层桥接 Antigravity/frontier agents/A2A agents 并导流到 Gemini Enterprise Agent Platform 和 Managed Agents API——即 "Kubernetes 战略" 复刻：runtime 开源，云上变现。
  - **ADK**：无直接关系。AX 不关心 agent 框架，只提供执行底座（harness/model agnostic）。
  - 致谢里点名 Google DeepMind（分布式 harness 前期工作）和 GKE 团队（隔离/resumption/调度）。
- **依赖关系硬约束**：必须有 Kubernetes + 集群内已安装的 Agent Substrate（Control API `api.ate-system.svc.cluster.local:443`）才能跑。这是它的前提，不是可选项。

## 3. 核心机制

### 3.1 架构（DESIGN.md）

```
ax CLI ──gRPC──> ax-server (无状态 API, :8080)
                    │  store & publish
                    ▼
                  Redis (Task Hashes + Event Streams + PubSub)
                    │  XREADGROUP
                    ▼
              ax-controller (可水平扩的 worker 池)
                    │  gRPC (Substrate Control API)
                    ▼
              Agent Substrate (atespace/actor/checkpoint)
                    ▼
              task 容器: ax-task-runner = PID 1
```

关键取舍：**不用 K8s CRD 存任务**——百万级短生命周期对象会打爆 etcd；状态放 Redis，用 Redis Streams 当工作队列。四个二进制：`ax`（CLI）、`ax-server`、`ax-controller`、`ax-task-runner`（沙箱内 PID 1）。

### 3.2 三个声明式原语（Task / Workspace / Model）

- **Task**：最小隔离执行单元（image + command + 资源限额 + env + workspace 绑定）。刻意做得小——"agent 会 plan/delegate/retry/fan-out，AX 不建模那个形状"，agent 自己组合 Task 树，每个节点拿到同样的沙箱/生命周期/工具。**不可变**（创建后）。phase: Running/Suspended/Failed/Terminating + conditions（WorkspaceReady/Ready）。
- **Workspace**：声明式"预热环境"——git repos（clone 到子目录）、内联文件（如 AGENTS.md）、MCP servers/registries、skill registries + 物化路径。一次声明多 Task 复用；绑定可带 `goal`（自然语言），首启时交给 agent 完成环境安装。
- **Model**：模型供应商配置（provider/model/参数/secret 引用）作为集群资源——换 key、锁版本、调参一次 `ax apply`，且 AX 自身组件（workspace planner）也读它。

### 3.3 执行/沙箱机制（亮点）

- **Suspend/Resume（最核心卖点）**：`ax suspend` checkpoint actor 状态（含 /workspace 卷快照），`ax resume` 在新容器里恢复同一文件系统但全新进程树。durable execution：网络中断/人审后可续跑。roadmap 上还有 **Stateful Task Branching**（fork 一个 running/suspended task 连同 checkpoint 探索多条执行路径）和 **idle 检测自动 suspend 提密度**。
- **Workspace maiden-run 标记**（`internal/workspace/setup.go`）：每个 workspace 首启 clone git（5 次重试，失败写 `/ax/git-error.log` 且**不写 marker 以便下次重试**）、写内联文件、建 skills 路径、跑 goal 引导；marker 在 `/ax/initialized-<path>`，resume 后不会重复 clone 破坏 agent 状态。
- **Goal-driven 引导**（`cmd/ax-task-runner/antigravity_bootstrap.py`）：把 goal 交给 Antigravity agent，策略是 `policy.workspace_only([dir]) + policy.allow_all()`（**deny 优先**，文件工具限制在 workspace 内，显式放开 run_command）；API key 只从环境读（避免进 ps）；默认 10 分钟超时（`AX_BOOTSTRAP_TIMEOUT` 可调）；agent 自身状态存 workspace 外（`/ax/antigravity`），不污染交付物。Git 失败不阻塞（记录后继续），bootstrap 失败也不阻塞（caller 决定）。
- **debug 门控的 guest services**（docs/sandbox.md）：runner 在 80 端口同时跑 HTTP（h2c 复用）+ gRPC guest services（进程服务：启停/流式输出/杀进程；文件服务：流式读写）。**默认关闭**（等于任意进程执行+文件访问），`spec.debug: true` 才开，`ax ssh` 拒连未开启的 task——远程进入沙箱是显式 opt-in 的安全决策。
- **Runner 存活语义**：PID 1 在命令退出后**继续活着**（metadata server 和 ax ssh 保持可用，exit code 记日志）；SIGTERM → 转发给命令进程组 → 10s 宽限 → SIGKILL。Runner 契约完全开放：任何语言实现 `/usr/local/bin/ax-task-runner` + 读 `AX_TASK_YAML`/`AX_WORKSPACES_YAML` + 满足 healthz/readyz 即可替换；也可 `import "github.com/google/ax/runner"` 嵌入。
- **路由**：task 无独立 Service/Ingress；所有流量走 Substrate 的 atenet-router，靠单 header `ate-target-actor: <atespace>/<task>` 寻址，router 负责先 resume 被 suspend 的 actor 再代理。
- **可替换 runner 三层定制**：扩镜像 → 嵌 `runner` Go 包（拿 `OnCommandExit` 回调）→ 从零写（任何语言，契约见 docs/runner.md checklist）。

### 3.4 多智能体协作？

**没有**。AX 不做多 agent 编排（无 planner/DAG/A2A），协作模型是"agent 自己 fan-out Task 树"。工具调用交给 MCP servers（Workspace 声明）；执行环境=沙箱容器。它是给 agent 平台当底座的 infra 层，不是 agent 框架。

### 3.5 外部评价

- InfoWorld（2026-05-25）：定位为生产级 agent 基础设施（durable execution、session consistency、connection recovery、trajectory branching）。
- dev.to：HN 社区对"billion agents"宣传有 skepticism；ax.ai 同名项目造成混淆。
- arXiv 2605.27575：第三方指出开源发行版缺 credential 管理（roadmap 里的 SPIFFE/治理项印证了这点）。

## 4. 与 wemux-mini 的关系

wemux-mini：自托管 AI agent 集群平台（server + 每 worker 一进程 + SQLite，session 级对话/流式/审批，runtime adapter 挂 agent CLI）。AX：K8s 上的声明式任务编排器，面向 cluster 级吞吐。**层级不同但问题域高度重合**：都是"远程跑不可信 agent 负载 + 观测 + 生命周期管理"。

### 重叠

| 能力 | AX | wemux-mini |
|---|---|---|
| 隔离执行单元 | Task（容器 actor） | session（worker 进程内） |
| 环境预热 | Workspace（git/文件/MCP/skills） | 项目绑定本地目录 |
| 进入执行环境 | ax ssh（debug 门控） | 远程终端（t3code 借鉴项） |
| 生命周期 | suspend/resume/checkpoint | 会话取消/恢复（语义未定） |
| 模型配置 | Model 资源 | runtime/model 目录上报 |

### 可借鉴（含源码路径，代码已在本地 `project/google-ax-upstream/`）

1. **Runner 契约（PID-1 supervisor 模式）** — `docs/runner.md` + `runner/runner.go` + `cmd/ax-task-runner/main.go`。一个薄 supervisor：HTTP `/healthz` `/readyz` + metadata 自描述端点（`/metadata/v1alpha1/ax/task`）+ 子进程组管理（SIGTERM 转发 + 宽限 + SIGKILL）+ **命令退出后继续活着**（供事后取证/查询）。wemux-mini 的 worker runtime adapter 可以吸收这套契约：healthz/readyz 区分"进程活着"和"环境就绪"，metadata 端点让 agent 无 SDK 自省配置（`AX_METADATA_URL`）。
2. **Workspace maiden-run 幂等预热** — `internal/workspace/setup.go`（marker 文件 + git 重试 + 失败不写 marker 下次重试 + RepoDirName 从 URL 推目录名）。mini 的项目绑定/首次进入本地目录时可套用：首次 setup 一次性完成并落 marker，重连/恢复绝不重跑，避免破坏 agent 已积累的文件状态。
3. **Goal-driven setup agent + 最小权限策略** — `cmd/ax-task-runner/antigravity_bootstrap.py`。模式：goal（一句话环境需求）→ 受限 agent（workspace_only deny-first policy + 超时 + key 只走 env + agent 状态放交付目录外）。mini 可把这个模式泛化到任意 agent CLI（opencode/codex/pi），作为"新项目首次接入"的自动化配置通道。
4. **Suspend/Resume 的语义定义** — `docs/concepts.md`（phase + conditions）、`DESIGN.md`（SuspendTask/ResumeTask RPC）、`internal/controller/reconciler.go`（SuspendActor 调用）。对 mini 直接可借的是**语义**而非实现：resume = 恢复文件系统状态 + 全新进程树（不是进程级 freeze），配合 conditions（Ready=False, reason=TaskSuspended）做观测；这正是 wemux-slim 调研里"断线语义必须重新定义"的参考答案。
5. **Debug 门控的 guest services** — `docs/sandbox.md` + `internal/guest/client.go`。进程执行+文件读写能力默认关闭、显式 opt-in、CLI 拒连未开启实例；HTTP 与 gRPC 在同一端口 h2c 复用。对 mini 的远程终端/文件访问是现成的权限模型（比 t3code 的窗口级借鉴多了一层"默认关"的安全姿态）。
6.（次级）**"状态别进 etcd"的取舍论证** — `DESIGN.md` 开头：百万级短命对象用 Redis Streams 而非 CRD。反向印证 mini 选 SQLite 而非重型中间件的方向。**Model 作为一等资源**（`internal/model/client.go`：SecretKeyRef + provider 参数集中管理，key 轮换一处改）也可直接搬进 mini 的模型目录设计。

### 不适用

- **K8s + Agent Substrate 硬依赖**：mini 是自托管单机/小集群（server+worker+SQLite），引入 Substrate/atenet/ko 部署链完全过度。
- **声明式 YAML apply UX**：mini 的入口是聊天/会话，不是 kubectl 式清单流。
- **billion-task 多租户 atespace、水平扩 controller**：mini 规模不需要。
- **Antigravity/Gemini 耦合**：默认 runner 绑 Google 栈；mini 需 provider 中立（AX 的 Model 抽象本身是中立的，可借）。
- **gRPC 控制面 + Redis**：mini 的 WS + SQLite 更贴合自托管目标。

## 5. 结论

**值得纳入借鉴源（与 t3code/multica 并列）**，定位互补：t3code 给了窗口/文件/终端的操作细节，multica 给了调度/steer/失败分类，**AX 给的是"agent 负载生命周期"的完整参考实现**——runner 契约、幂等 workspace 预热、suspend/resume 语义、debug 门控访问、Model 资源化。Apache-2.0 无合规负担，代码极小（65 文件，核心逻辑半天可读完），且是 Google 少见的"把内部 agent infra 模式开源"的样本。

注意两点：① 早期项目（官方警告破坏性变更 + 暂停外部 PR），借鉴模式而非锁定 API；② 架构层（K8s/Substrate/Redis）整体不适用于 mini，只取契约与语义。建议在 upstream-comparison 中把 AX 标注为"lifecycle/runner-contract 参考源"。

## 出处

- 仓库：https://github.com/google/ax （元数据：Apache-2.0, Go, 11,949 stars, created 2026-03-30）
- 本地代码：`project/google-ax-upstream/`（README.md, DESIGN.md, docs/concepts.md, docs/sandbox.md, docs/runner.md, docs/manifests.md, docs/networking.md, docs/roadmap.md, internal/workspace/setup.go, cmd/ax-task-runner/antigravity_bootstrap.py, internal/model/client.go, internal/controller/reconciler.go, internal/tunnel/tunnel.go, runner/runner.go）
- InfoWorld: Google adds open source Agent Executor to support AI agents in production (2026-05-25) — https://www.infoworld.com/article/4176801/google-adds-open-source-agent-executor-to-support-ai-agents-in-production.html
- Techzine: Google launches open-source runtime for AI agents — https://www.techzine.eu/news/devops/141577/
- dev.to（HN 反应 + 时间线）— https://dev.to/jamilxt/google-open-sourced-ax-an-orchestrator-for-billions-of-ai-agents-hacker-news-isnt-buying-the-5hgf
- HN thread: https://news.ycombinator.com/item?id=49780797
- Agent Substrate：https://github.com/agent-substrate/substrate （rakyll 2026-09 宣布）
- arXiv 2605.27575（第三方对比，指出开源版缺 credential 管理）
