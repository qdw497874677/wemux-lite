# One ADK-based conversation contract

Wemux 只定义一套由 Worker 对外提供的、版本化的 Wemux ADK Profile，并以 Google ADK 的 Session、Invocation、Content、Event、Actions、Command、Approval、Cancel 与终态语义为基线。本地 Worker Web 与集群 Server 都使用这套契约；Worker–Server 长连接只为它增加身份认证、心跳、ACK、重连和同步等传输封装，不形成第二套对话模型。

Wemux ADK Profile 保证与 Google ADK 核心类型的语义和结构可无损映射，但 wire schema 由 Wemux 自己版本化，不直接绑定某个 `@google/adk` SDK 版本或其内部序列化格式。当前 Profile 标识 `wemux.adk.v1` 在 `@wemux/domain` 中定义；`@wemux/agent-interchange` 的 `AgentEvent` 是唯一公共执行 Event。Wemux 扩展放入 `customMetadata.wemux`，Provider 扩展放入 `customMetadata.provider`；真正接入 ADK Agent 时由可选 Adapter 连接官方 SDK。

Worker 内部的 `AgentSignal`/`AgentTurnEvent` 不是公共协议；`SessionEventPayload`/`JournalEvent` 是从 `AgentEvent` 单向生成的持久化与 UI 读模型；Transport v2 的 epoch、sequence、messageId、ACK 和重连状态只属于可靠交付封装。三者不得演化成独立的对话协议，也不得被客户端作为 Provider 原生事件使用。

Pi、Claude Code、Codex 等原生 Agent 由 Worker 内的 Adapter Bridge 转换到该契约。Project、Workspace、Worker、Task、权限和治理等能力通过独立的非对话 Management API 提供，不混入 ADK Event 流。

集群 Web 永远连接 Server，由 Server 完成用户与资源授权，并通过 Worker 主动建立的长连接中转 Wemux ADK Profile 的 invocation、command 和 event；浏览器不直接持有 Worker Credential，也不要求 Worker 暴露可被浏览器访问的地址。本地 Worker Web 可以使用本机身份直连本 Worker，但仍使用同一个 Wemux ADK Profile。
