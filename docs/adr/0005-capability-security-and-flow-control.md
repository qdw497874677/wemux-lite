# Capability, security, and flow control

Worker 与 Server 建立逻辑长连接时协商 transport major、Wemux ADK Profile 版本和 feature flags。transport major 不兼容时拒绝连接；ADK Profile 选择双方支持版本；未声明的能力不得下发或静默降级。

Agent Capability 必须描述 Agent 版本、安装与认证状态、健康状态、模型、最大并发，以及 streaming、resume、tool events、approval、steering、cancellation、artifacts 和 structured output 等特性。Server 基于实际声明进行路由。

Approval 属于 Wemux ADK Profile。请求以结构化 Event 发出，Invocation 进入 `waiting_for_approval`；决定绑定 `invocationId + approvalId`。超时、断线或无人处理均不得自动批准，Adapter 负责映射 Provider 原生审批机制。

Agent Provider 登录态、模型密钥、Git 凭证及其他执行 Secret 只保存在 Worker。Server 只保存 capability、credential reference 和可用状态，不读取或下发用户私钥。Adapter 必须在原始输出进入 Journal 前脱敏。

流量分级处理：非 partial Event 必须持久化、可重放且不能静默丢弃；partial delta 可以合并、限速或丢弃。control、cancel 和 approval 的优先级高于文本 delta，每个 Session 使用有限缓冲，慢消费者不得导致 Worker 内存无限增长。即使实时流缺失，持久化 Event 仍必须恢复正确历史。
