# 飞书应用机器人 Channel 运维指南

## 当前验收边界

协议 fixture 已验证，包括 URL verification、verification token、Encrypt Key 解密、事件 v2.0、`event_id` 去重、tenant token、401 重取、限流退避、消息分片与幂等发送。**真实飞书阻塞待部署者提供测试应用和公网 HTTPS 回调，不得据此文档声称已支持生产飞书。**

## 前置条件

1. Server 配置 `WEMUX_CONNECTOR_ENCRYPTION_KEY`，用于以 `enc:v2` 保存 `app_id`、`app_secret`、Verification Token 和可选 Encrypt Key。
2. Server 必须有飞书可访问的公网 HTTPS 地址。事件订阅 URL 为：
   `https://<public-host>/hooks/feishu/<channel-id>`
3. 在飞书开放平台创建企业自建应用，启用机器人能力。

## 开放平台配置

1. 在 Wemux 项目的 Channel 页面选择“飞书应用机器人”，填写 App ID、App Secret、Verification Token；启用事件加密时再填 Encrypt Key。
2. 创建后复制页面展示的事件订阅 URL，填入飞书开放平台“事件与回调”。平台发送 challenge 时 Wemux 只验证、解密并返回 challenge。
3. 订阅事件 `im.message.receive_v1`。
4. 至少授予读取消息事件和以应用身份发送消息所需权限；具体权限名以开放平台当前控制台提示为准，并发布应用版本。
5. 创建 binding：外部会话键填写飞书 `chat_id`，目标选择已有 Session。私聊直接触发；群聊只有事件中包含当前机器人 mention 才触发。

## 密钥轮换

当前管理入口采用创建新 Channel 后迁移 binding 的显式轮换方式，旧 Channel 停用会取消未发送投递。切换前先在飞书控制台与 Wemux 同步新凭证，完成 challenge 测试后再停用旧 Channel。`credentialRevision` 变化会隔离 tenant token 缓存。

## 可靠性与诊断

- 回调 ACK 路径只做协议验证/解密和持久化；Session 路由在 ACK 后异步执行。
- `event_id` 是强幂等键；入站记录保留 7 天。重复事件成功 ACK，不重复入队。
- 不支持事件、机器人自身消息、非文本消息、群聊无 @ 均成功 ACK，并在 Delivery 诊断记录忽略原因。
- tenant token 按 `(channelId, credentialRevision)` 单飞缓存，在过期前 60 秒刷新。API 401 时强制刷新并仅重放一次。
- 429 尊重 `Retry-After`，否则指数退避；最终投递状态在 Channel 页显示为 `delivered`、`retry_wait` 或 `dead_letter`。
- 回复降级为纯文本，按 4000 Unicode code point 分片；每片 UUID 由投递 ID 与分片序号稳定派生。

## 常见故障

- challenge 401：检查 Verification Token；加密事件还需检查 Encrypt Key。
- tenant token 失败：检查 App ID/App Secret、应用状态、Server 到 `open.feishu.cn` 的网络。
- 收到事件但 Session 无消息：检查 binding 的 `chat_id`、Session/Worker 权限、群聊是否 @ 机器人，并查看入站诊断。
- 回复 400/403：检查机器人发送权限、应用是否发布、机器人是否在群内。
- 回复 429：保留投递等待自动退避，不要频繁手工重放；同时查看飞书租户级限流。
