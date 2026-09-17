# Worker is the only Agent network node

Wemux 只允许 Worker 作为执行节点主动通过版本化长连接加入 Server；Pi、Claude Code、Codex 等 Agent 始终作为 Worker 管理的本地能力，通过通用 Adapter 契约桥接。我们不允许 Agent 直接注册或连接 Server，因为那会让每种 Agent 重复承担身份、认证、重连、Workspace、Journal 与可靠性职责，并迫使控制面同时维护两套网络和权限模型。

每个 Worker 对每个 Server 只维持一条可重建的逻辑长连接，并在连接内多路复用 Worker 控制、能力状态、Workspace 操作以及所有 Session 和 Invocation 消息。Session 只是逻辑流，不单独建立连接。WebSocket、HTTP/2 或 QUIC 属于可替换的传输实现，不改变 Wemux ADK Profile。
