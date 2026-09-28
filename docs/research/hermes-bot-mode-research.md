# Hermes Bot Mode 调研:对 wemux-mini Agent 协作设计的启发

日期:2026-09-28。来源:hermes-agent 官方文档 bot-mode 页 + background-systems 参考 + 本机 Hermes 运行实证(我自己就跑在飞书通道上)。定位:给正在进行的 P2 协作设计(docs/design/agent-collaboration-p2-architecture.md,pi 设计中)补充第三份参照(前两份:paperclip、我们自己的 H4 通道)。

## 一、Hermes Bot Mode 是什么

把 Hermes profile 变成一组具名 **Bot**:每个 Bot 有独立角色/模型/记忆/技能/头像;跑定时例程、在群聊里共同商议、点对点互发消息。关键架构事实:

1. **Bot 就是 profile,不发明新原语**:Bot = 隔离的 config/memory/skills/凭证/聊天史(`~/.hermes/profiles/<name>/`)。Bot Mode 只是这个原语之上的 UI——CLI(`hermes -p <bot> chat`)与 UI 完全等价,"no core patches, no background daemons, no extra storage"
2. **Routines = 命名空间的 cron**:`[bot:<name>] <routine>` 就是普通 cron job,Bot 的例程运行落进该 Bot 自己的 canonical Bot Chat(结果出现在你本来就会跟它说话的地方)
3. **Bot-to-bot 消息**:`message_agent(target, message)` 工具;目标校验对 live roster、自动加 `Message from 🤖 <名> (@<handle>):` 署名前缀、投递进对方 Bot Chat;名字冲突时拒绝并列出 roster 而不是猜
4. **协议注入而非硬编码**:`agent.bot_mode_protocol: true` 把 bot 间消息协议注入每个 Bot Chat 的上下文——**bots 自己学会**队友存在与可达方式;peer 注册/移除在下一条消息(capability epoch)自动刷新协议
5. **有意沉默**:没事可说的 Bot 用 `[SILENT]`/`NO_REPLY` token 结束 turn;transcript 保留但 UI 不渲染,发消息方收到空回复而非 token 本身(协议语义与展示分离)
6. **跨机器两条路**:Desktop relay(多连接,`message_agent` 直达远端 bot)+ `hermes peer`(网关对等注册,`peer dm/run/status/stop`,支持 idempotency-key 的长任务);NAT 单向可达即可用
7. **群聊 turn 仲裁**:多个 room worker 共享 home 时,持 room driver **lease** 的跑下一 turn;成员的 room session 只在其 turn 期间持有,lease 可迁移;`turn.started/turn.settled` 落持久 room log,中间过程(tools/approvals/流文本)经 `on_room_member_activity` hook 投影给插件

## 二、对 wemux-mini 的启发(按价值排序)

### 1. 「Agent 即 profile」的实体观(直接映射我们的 Session/Agent)

我们的 Agent 已接近这个形状(Worker 上 agent use/install、独立运行时),但缺「持久对话身份」:Hermes 的 canonical Bot Chat(每 Bot 一个 forever-chat,后续 run resume)让"跟同一个 agent 说话"有连续记忆载体。**建议**:P2 的 Delegation 结果回投 + D1 的 inbox 扩展,目标地址从"session"升级为"agent 的 canonical session"(每 agent 一个可复用主会话),这正好用我们已有的 Session reuse mode,零新原语。

### 2. 协议注入 + capability epoch(解决"agent 怎么知道有队友")

我们已有 `agent.list` 工具,但 agent 不知道「怎么协作」。Hermes 的做法:把协作协议(消息格式/署名规则/沉默 token/roster)作为**上下文注入**并在 roster 变化时刷新(capability epoch)。**建议**:我们的 capability snapshot 已有版本机制,把「协作协议说明」作为 snapshot 的注入内容,worker 侧 launch 时带进 system context——不用改 agent 运行时。

### 3. 有意沉默 token(群聊/多 agent 场景的降噪协议)

我们的飞书/钉钉通道 + 未来多 agent 群聊会立刻遇到"每个 bot 都回一句"的噪音问题。`[SILENT]` 语义(protocol 层识别、UI 层不渲染、发送方得空回复)是成熟解法,**直接借模式**进 P2 的协作协议。

### 4. 跨机器 peer 模型(对照我们的跨 Worker 路由)

Hermes 的 `hermes peer`(网关对等 + API key + idempotency-key 长任务)与我们的 D2(跨 Worker 路由)同构,差异:它是对等网关互联,我们是 Server 中转星型。**借鉴点**:peer 的 idempotency-key 语义(长任务可查询/可停止:run/status/stop 三命令)正好是 D2 委派 dispatchId 需要的查询面;NAT 单向可达的设计约束(注册方主动拉)与我们 worker 出站连接模型一致。

### 5. Room lease 仲裁(多 agent 群聊的并发控制)

持 lease 者跑下一 turn、session 只在 turn 期间持有、lease 可迁移、turn 边界落日志——这是「多 agent 共享一个对话」的并发正确性核心。**建议**:若 P2 后做「通道群聊绑定多 agent」(一个飞书群多个 bot),抄这个 lease 模型;首版单 agent 绑定不需要。

### 6. Kanban 队列(多 agent 任务板的成熟语义)

Hermes kanban:dispatcher 原子认领/reclaim 过期认领/failure_limit 自动 block/板为硬边界(env 钉死)。对照我们 Task 线:已有 assignee 语义,缺「worker agent 自助认领 + 过期回收」。**建议**:这是 G49 Routines 之后「agent 拉模式取任务」的参照,记入 M8 备选,不进当前批次。

## 三、落地建议(并入 P2 设计文档的评审输入)

D1(同机委派核心)直接吸收:①agent canonical session 作为回投地址(Session reuse 零成本);②协议注入进 capability snapshot;③`[SILENT]` token 进协作协议。D2(跨 Worker)吸收 peer 的 idempotency-key/run-status-stop 查询面。D3 之后备选:room lease(群聊多 agent)、kanban 认领(agent 拉模式)。

与 paperclip 参照的分工:paperclip 给队列/原子签出/孤儿恢复的**可靠性语义**,Hermes Bot Mode 给**交互协议与实体观**(agent 身份连续性/协议注入/沉默/署名)。两者叠加正好覆盖 P2 设计的两半。

不抄的:Hermes 的桌面 relay(我们有 Server 星型)、多 gateway 对等网关(同上)、skin/avatar(装饰性)。
