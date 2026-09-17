# Reliable Worker command delivery

Server 向 Worker 下发的消息采用“至少一次传输 + Worker 侧持久化幂等去重 + 可查询执行状态”，不宣称分布式 exactly-once。

对话调用不另造一套 command 身份：它直接使用 Wemux ADK Profile 的稳定 `invocationId` 作为调用身份与幂等键，所有 Event 以自身 `id` 唯一标识并关联该 `invocationId`。网络 envelope 的 `messageId` 仅用于投递去重、ACK 与重发关联，不进入对话领域模型。取消、批准等操作必须明确关联目标 `invocationId`。

非对话管理操作使用稳定 `commandId`。Server 必须先持久化待投递消息再发送；Worker 在产生副作用前持久化其接收与处理状态。重连时重发原 `invocationId`、`messageId` 或 `commandId`，不得重新生成业务身份；Worker 返回已有状态或结果，不重复执行。

ACK 只表达 `accepted | rejected`：`accepted` 表示 Worker 已持久接收，不能解释为执行完成。对话执行结果由 Wemux ADK Profile 的唯一终态 Event 表达；非对话管理操作由独立结果消息表达。无法天然幂等的 Workspace 操作必须保存首次结果，或携带明确的预期资源版本作为前置条件。
