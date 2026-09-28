# block/buzz 调研报告

> 调研日期：2026-09-27 · 调研人：Hermes subagent · 服务对象：wemux-mini 借鉴源评估
> 证据来源：GitHub API 实时查询 + 官方 ARCHITECTURE.md / AGENTS.md / VISION.md / crate README（已下载至 `project/buzz-upstream-docs/`）

---

## 1. 指向确认（消歧）

**候选列表：**

| 候选 | 说明 | 判定 |
|------|------|------|
| **github.com/block/buzz** | Block, Inc.（Square/Cash App 母公司）出品，"A hive mind communication platform"，人类+AI agent 协作工作区 | ✅ **选定** |
| github.com/block/sprout | 搜索结果中显示 stars 22,505、同一描述、同一创建时间 2026-03-06T21:00:56Z | 同一项目的**旧名/重定向**（Block 内部构建体系仍叫 sprout：`squareup/sprout-releases` 等），非独立候选 |
| 其他同名 buzz | buzz 是常见项目名（音频/社交类） | 搜索中未出现与"block 组织 + AI agent/开发工具"匹配的其他候选 |

**选择理由与证据：**
- 任务给定的第一候选 `block/buzz` 真实存在，且**恰好是 AI agent + 开发工具向**：README 自述 "Yes, it's another AI-adjacent developer tool... agents can open repos, send patches, review code, run workflows, edit canvases, **orchestrate other agents**, drop into voice huddles"。
- GitHub API（2026-09-27 查询）：`full_name: block/buzz`，stars **34,970**，forks 4,603，license Apache-2.0，language Rust，created 2026-03-06，pushed_at **2026-09-26**（调研前一天仍在推送）。
- 组织背景铁证：Block 开源页 opensource.block.xyz 列出 MCP（Block 贡献了 Rust 实现）、goose 等 agent 基建；buzz 是 Block 内部真实使用的产品（员工用 `squareup/buzz-releases` 内部分发，AGENTS.md "I work at Block → use the internal build"）。

---

## 2. 它是什么

| 维度 | 事实 |
|------|------|
| **作者/组织** | Block, Inc.（NYSE: SQ；Square/Cash App/Weebly/TIDAL 母公司），有专职团队（Collaborator: joeyblack4、sandro-sq、jmecom、wesbillman、hr-o 等），内部 Kubernetes 生产部署（Terraform+ArgoCD，见 AGENTS.md 生态图） |
| **一句话定位** | 自托管的"人+AI agent 平等协作"团队工作区：聊天频道、画布、工作流、语音 huddle、git forge 全部跑在一个自有 relay 上，基于 Nostr 协议，agent 与人用同一套身份/权限/审计 |
| **技术栈** | Rust monorepo（Axum relay + sqlx/Postgres 17 + Redis + S3/MinIO）；desktop = Tauri 2 + React 19；mobile = Flutter/Riverpod；web 客户端；`#![deny(unsafe_code)]` 全仓禁 unsafe |
| **成熟度** | 创建仅 ~7 个月：34,970 stars / 4,603 forks / 2,619 commits / 3,355 open issues / 1.8k open PRs（外部贡献爆发式）；Desktop 已发到 **v0.5.20**；134 个 e2e 测试；VISION.md 状态表：relay/harness/desktop/workflow/CLI/personas/Mesh 均 ✅，审批门(WF-08)与 mobile 🚧 |
| **License** | **Apache-2.0**（LICENSE 文件 + API license.spdx_id 双确认） |
| **开源可用** | ✅ 完全可用：docker-compose 自托管 + Railway 一键部署 + 从源码构建三路径齐全；Block 内外部同源代码（内部只差构建管线） |

---

## 3. 核心机制（架构与亮点）

### 3.1 总架构：relay 是唯一真相源

```
Clients(人: desktop/web/mobile + agent: buzz-cli)
   └─WebSocket(NIP-01/NIP-42)→ buzz-relay(Axum)
        ├─ buzz-db(Postgres 事件存储+FTS)   ├─ buzz-pubsub(Redis 扇出/presence/typing)
        ├─ buzz-auth(NIP-42/98, 14 scopes)  ├─ buzz-search(FTS)  
        ├─ buzz-audit(哈希链审计)           └─ buzz-workflow(YAML 自动化)
```

关键原则（ARCHITECTURE.md L97）：子系统互相隔离（workflow 不调 pubsub、search 不调 db），**跨子系统协调只经 relay**——避免 God-crate 之外的一切横向耦合。

### 3.2 一切皆签名 Nostr 事件 + kind 注册表

- 每个动作（消息/reaction/画布更新/工作流步骤/语音事件）= 一个密码学签名 Nostr 事件，用 `kind` 整数分发。**新功能 = 新 kind 号，老客户端零破坏**。127 个 kind 注册于单一来源 `crates/buzz-core/src/kind.rs`；40000–49999 是自定义区（如 `KIND_CANVAS=40100`、`KIND_JOB_REQUEST=43001`、`KIND_FORUM_POST=45001`）。
- 事件管道 11 步固定顺序（ARCHITECTURE.md §4）：AUTH→PUBKEY MATCH→签名验证(spawn_blocking)→频道成员检查→DB 幂等插入→Redis 发布→三级索引扇出→审计(fire-and-forget)→工作流触发(fire-and-forget)。
- 官方准则（AGENTS.md "Key Patterns"）：**新增能力优先建模为 Nostr 事件而非新 HTTP 端点**——免费获得实时扇出、权限和审计。

### 3.3 buzz-acp：agent harness（与 wemux-mini 最相关）

`Buzz Relay ─WS→ buzz-acp ─stdio ACP/JSON-RPC→ agent 子进程(goose/codex/claude code/任意 ACP)`

- **1–32 agent 进程池**，claim/return 生命周期（`pool.rs` 2,253 LOC；`queue.rs` 2,565 LOC；`relay.rs` 3,143 LOC）。
- **每 channel 至多 1 个 in-flight prompt**，后续 @mention 排队并**合并成单个批量 prompt**（省 token、保序）。
- **崩溃自愈**：agent 子进程 crash 检测+respawn；relay 断线用 `since` 过滤器重连不丢事件；入队溢出有 ≥5s 间隔的限流重放。
- **lazy-pool**：先连接/订阅/接单，首个事件才唤醒 ACP/LLM 子进程（省常驻成本）。
- **入站作者门禁**：`owner-only / allowlist / anyone / nobody` 四模式 + owner 控制命令 `!cancel / !rotate / !shutdown`（作用域可为 channel 或 thread）。
- **heartbeat 语义**：空闲时低优先级触发（事件优先、全员忙则丢弃 tick、全局至多 1 个 in-flight），默认 prompt 拉 `get_feed_actions()/get_feed_mentions()` 捞待办。
- **BYOH 三层 harness 目录**：tier1 编译内置（goose/claude/codex）→ tier2 preset 静态目录（Cursor/OpenCode/Pi/Amp/Hermes Agent 等，`desktop/src-tauri/src/managed_agents/discovery/presets.rs`）→ tier3 用户 JSON（`<app-data>/custom_harnesses/`）。安全约束：preset/custom 永不自动装、env 定义只是下限、Buzz 保留 env 键强制剥离。

### 3.4 其他亮点

- **Canvas**：每频道一份共享文档（kind 40100 + `channels.canvas` 列），desktop/MCP/CLI（`buzz canvas get/set`）三路读写；PR #7046 加了"channel manager 才能写画布"的权限。
- **看板**：desktop 项目任务看板（PR #7048 `feat(desktop): add project task kanban board`，2026-08-30）；agent job 走 `KIND_JOB_REQUEST(43001)`。
- **buzz-workflow**：YAML-as-code，4 触发器（消息/reaction/cron/webhook）×7 动作，evalexpr 条件带 100ms 超时防恶意表达式，审批门已建库/UI 未接线（WF-08），循环防护（执行类 kind 46001–46012 不再触发 workflow）。
- **buzz-agent**：反框架的极简 ACP agent——"Not a router. No agent-to-agent, no orchestration. One model. One loop." + **Bounded Everything 表**（15 项硬上限：帧 4MiB、prompt 1MiB、单轮工具调用 64 次、MCP 子进程 `setpgid`+`killpg` 连根杀…）+ 回归测试即 changelog（每个 test 名字对应一个真实 bug）。
- **分支即频道**：relay 直接 host git（smart HTTP + npub 签名 push），feature branch 自动开频道承载 CI/评审/合并决策，merge 后频道归档为永久记录（VISION.md "Code" 节）。
- **Hash-chain 审计**：SHA-256 链 + `pg_advisory_lock` 单写者 + `catch_unwind` 防 panic 死锁。
- **Buzz Mesh**：relay 门控的成员 GPU 算力池（mesh-llm over iroh），agent 经本地 OpenAI 兼容端点消费。
- **AGENTS.md Review-Proven Rules**：从 25→71 个 PR 的 agent review 提炼 8 条工程规则，53% 的 review 发现是重复类；修复率数据佐证（测试接缝绑定/资源有界类 100% 被修）。规则包括：①捕获的失败必须留持久重试记录或上抛；②异步结果按 generation 围栏+所有删除路径清理派生元数据；③回归测试绑定生产接缝且可证伪；④一切资源/循环/进程树有界；⑤单用户动作=单原子持久化；⑥guard 不得隐藏唯一恢复路径；⑦每个新视觉组件过无障碍审计；⑧每种输入模态（键盘/指针/热键）都是一等接缝。

---

## 4. 与 wemux-mini 的关系

**定位对照**：wemux-mini = wemux 灵魂（团队/多 worker/画布/看板）+ 通用 AI IDE。buzz = 人+agent 混合团队的**工作区形态**（频道/画布/工作流/harness 池），**不含 IDE 编辑器**。二者是"工作区层 vs 编辑器层"的互补关系，重叠仅在多 agent 编排与团队协作面。

### 可借鉴点（按优先级）

| # | 借鉴点 | 源码/机制出处 | 对 wemux-mini 的落法 |
|---|--------|--------------|---------------------|
| 1 | **buzz-acp 的 harness 生命周期**：per-channel 串行（每通道至多 1 in-flight）、mention 批量合并单 prompt、crash respawn、断线 `since` 续传、lazy-pool、owner 门禁 + `!cancel/!rotate/!shutdown` | `crates/buzz-acp/src/{queue.rs(2565 LOC), pool.rs(2253), main.rs(2457), relay.rs(3143)}` | wemux-mini 的 worker/harness 管理层直接照此模式：任务通道串行化+批量合批+自愈。与 multica（调度/steer）互补——multica 管"派什么活"，buzz-acp 管"runtime 进程怎么活" |
| 2 | **事件驱动 + kind 注册表扩展模型**：新能力=新事件类型（单一来源文件），ingestion 固定管道（验证→鉴权→持久化→扇出→审计→触发），"优先事件而非新端点" | `crates/buzz-core/src/kind.rs`（127 kinds 单一来源）+ ARCHITECTURE.md §4 事件管道 | wemux-mini 的团队事件总线（worker 产出、看板变更、画布更新）可复用此演进策略：任务卡/画布 diff/生命周期全部是带类型事件，UI 与 agent 同源消费，老消费者零破坏 |
| 3 | **Canvas 最小机制**：频道挂一份共享文档（kind 40100 + `channels.canvas` 列），get/set 全量读写，写权限收敛到 channel manager（PR #7046） | `buzz-core/src/kind.rs` KIND_CANVAS、`buzz-db` channels 表、`buzz-cli` `canvas get/set` | wemux 画布不必上 CRDT/实时服务，MVP = 频道级共享文档 + 事件广播 + 角色写权限；后续再演进 |
| 4 | **BYOH 三层 harness 目录**：编译内置→preset 静态目录（PATH 探测可用性，永不自动安装）→用户 JSON；安全底线（env 只做下限、保留键强制剥离） | `desktop/src-tauri/src/managed_agents/discovery/presets.rs` + `<app-data>/custom_harnesses/*.json` schema（buzz-acp README "BYOH" 节） | wemux-mini 接入多 agent runtime（codex/claude/opencode/pi/amp…）的目录化设计，用户无 PR 自扩展，避免硬编码 |
| 5 | **AGENTS.md Review-Proven Rules（8 条）+ Bounded Everything** | 仓库根 AGENTS.md（Review-Proven Rules 节）、`crates/buzz-agent/README.md`（Bounded Everything 表） | 纯方法论零成本搬：写进 wemux-mini 的贡献/评审规范与 harness 实现清单（资源全有界、单动作单持久化、异步 generation 围栏、回归测试绑定生产接缝） |
| 6 | （次级）**看板即事件**：任务卡=签名事件流转，`KIND_JOB_REQUEST=43001`，agent 与人同权读写 | `buzz-core/src/kind.rs` + desktop PR #7048 | 与 multica 看板借鉴合并：任务实体的事件化表示 |

### 不适用项（明确排除）

- **Nostr 密码学身份**（每事件 secp256k1 签名、NIP-42/98 认证、npub 身份体系）：wemux-mini 是本地/单租户 IDE，全套密码身份过重——只取"事件+kind"的形态，丢掉签名层。
- **多节点 Redis 扇出、多社区多租户**（TenantContext/host 解析/`buzz:{community}:*` key 隔离）：单机产品用不上。
- **Huddle 语音**（内置 Opus SFU）、**Flutter mobile**、**Blossom/S3 媒体**、**Postgres 月度分区+FTS**（wemux-mini 更可能 SQLite）：超范围。
- **Rust 技术栈本身**不可搬（wemux-mini 是 TS）——只能学机制，不能贴代码（见下 License 判定的实操约束）。
- **git forge/分支即频道**：理念漂亮但依赖 relay-hosted git，与 wemux-mini 的本地 IDE 定位不匹配，仅作设计参照。

---

## 5. 结论

### 是否纳入借鉴源：✅ 纳入，与 t3code/multica/ax 并列（第五源）

分工互补：**t3code（IDE 主体，抄码）/ opencode（微交互）/ multica（调度·steer·看板）/ google-ax（生命周期）/ block-buzz（人+agent 混合团队的工作区形态：harness 池、事件总线、画布、BYOH 目录、agent 工程规则）**。buzz 填的正是"wemux 灵魂"里团队协作层的机制空白，且其 buzz-acp 是目前开源里最完整的多 runtime agent harness 参考实现。

### License 判定：Apache-2.0 → **可抄码（宽松）**

- Apache 2.0 允许复制、修改、再分发（含商用），唯一义务：保留原 LICENSE/版权声明，修改过的文件建议标注；比 MIT 还**多显式专利授权**（第 3 条），对借鉴方更安全。
- 实操注意：
  1. 抄 Rust→TS 只能是**翻译式借鉴**（逻辑/结构/常量设计），不存在逐字复制，归属义务自然很轻；若直接复制代码片段或文档（如 Review-Proven Rules 原文），需带 `// Adapted from block/buzz (Apache-2.0) Copyright Block, Inc.` 式标注 + LICENSE 副本。
  2. 该仓库贡献走 **DCO**（`git commit -s`）——只影响向上游提交 PR，不影响下游借鉴。
- 对比结论：与 t3code（MIT）同为"可抄码"档；buzz 的工程文档（ARCHITECTURE.md/AGENTS.md）本身就是高质量教材，机制层价值 ≥ 代码层。

### 证据附录

| 事实 | 证据 |
|------|------|
| stars/forks/license/活跃度 | GitHub API `GET /repos/block/buzz`（2026-09-27）：34,970 stars · 4,603 forks · Apache-2.0 · pushed_at 2026-09-26 · size 581,984 KB |
| 架构/kind/事件管道 | 官方 ARCHITECTURE.md（853 行，本地 `project/buzz-upstream-docs/ARCHITECTURE.md`） |
| harness 池/门禁/heartbeat/BYOH | 官方 `crates/buzz-acp/README.md`（本地副本） |
| Bounded Everything/反框架宣言 | 官方 `crates/buzz-agent/README.md`（本地副本） |
| Review-Proven Rules | 官方 AGENTS.md（本地副本） |
| 画布/看板 PR | PR #7048（desktop kanban）、#7046（Canvas 写权限） |
| Block 出品 | AGENTS.md 生态图（squareup/sprout-releases 等 4 repo）+ opensource.block.xyz |

> 附注：仓库 ~570MB 超 30MB 门槛，未下载源码 tarball；改为下载 8 份关键官方文档至 `project/buzz-upstream-docs/`（ARCHITECTURE/README/AGENTS/VISION/NOSTR + buzz-acp/buzz-agent/buzz-cli README）。文中源码路径均为官方文档自引路径，可信。
