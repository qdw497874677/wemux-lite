# 钉钉 Stream Channel 运维指南

## 能力与边界

Wemux Lite 的钉钉 Channel 使用企业内部应用机器人的 Stream 模式。Server 主动建立 WebSocket 反向连接，因此不需要公网入站地址，也不需要回调加解密。自定义机器人 webhook 与 SEC/HmacSHA256 加签不在本能力范围内。

当前接收文本消息：单聊直接触发，群聊仅在机器人位于 @ 列表时触发。其他消息类型会立即 ACK 并留下忽略审计。回复优先使用入站消息携带的 `sessionWebhook`。

## 开放平台配置

1. 登录[钉钉开放平台](https://open-dev.dingtalk.com/)，在目标企业创建企业内部应用。
2. 为应用添加机器人能力，并启用机器人接收消息。
3. 在事件与回调配置中选择 Stream 模式。
4. 订阅机器人消息 topic `/v1.0/im/bot/messages/get`。如需其他事件，按开放平台 Stream 推送配置增加 topic；Wemux Lite 当前只消费机器人文本消息。
5. 发布应用，并把机器人安装到允许使用的组织与群聊范围。
6. 在应用凭证页获取 Client ID（AppKey）与 Client Secret（AppSecret），在机器人配置页确认机器人 Code。不要把 Secret 写入日志或源码。

## Wemux Lite 配置

1. 进入项目的“外部 Channel”页面，选择“钉钉 Stream 机器人”。
2. 填写名称、Client ID、Client Secret 与机器人 Code，然后保存。
3. Server 会加密保存凭证并主动连接钉钉 Stream 网关。列表诊断会显示“连接中”“在线”或“离线”。
4. 点击“连接测试”会请求一次短期 Stream ticket，用于等价验证应用凭证与网关开放状态，不会保留测试连接。
5. 创建 binding，把钉钉 `conversationId` 映射到既有 Session。可选回复回调 URL 通常留空，首次有效入站消息会携带会话级 `sessionWebhook` 并用于回复。

启用、禁用与 Server 重启都会管理连接生命周期：每个 Channel 同时最多一条连接；断线按指数退避重连；凭证 revision 更新后重建连接；Server 关闭时主动停止全部连接。

## 权限与网络

- Server 需能访问 `https://api.dingtalk.com` 与网关返回的 `wss://` 地址。
- 出站代理或防火墙必须允许 HTTPS 与 WebSocket Upgrade。
- Stream 模式无需开放 Server 公网端口。
- 凭证使用 H2 `enc:v2` Server 实例密钥加密。缺少 `WEMUX_CONNECTOR_ENCRYPTION_KEY` 时 Channel 凭证功能不可用。

## 排查

### 鉴权失败

- 核对 Client ID、Client Secret 是否来自同一个企业内部应用。
- 确认机器人能力、Stream 模式已启用且应用已发布。
- 运行页面“连接测试”；HTTP 401/403 会分类为鉴权失败，不会无限重试。

### 一直离线或反复重连

- 检查 Server 到 `api.dingtalk.com` 的 DNS、TLS 与代理。
- 检查企业出口是否允许 WebSocket。
- 查看页面诊断的最后错误与重连次数。
- 网关 ticket 为短期凭证，每次重连都会重新获取；不得缓存复用旧 ticket。

### 群消息不触发

- 群聊必须真实 @ 机器人，消息体 `isInAtList` 才会为真。
- 核对 binding 的 `conversationId` 与消息所在群一致。
- 检查 sender allowlist 与 binding 是否启用。

### 收到消息但没有回复

- 当前只处理文本类型。
- 回复要求存在有效 `sessionWebhook`；缺失时投递进入死信，不会改走自定义机器人 webhook。
- `sessionWebhook` 的 5xx、429 与网络错误进入重试；其他 4xx 进入死信。
- 长回复会按钉钉 20,000 字符上限分片，并为每片携带确定性 `clientId` 幂等键。

## 验收状态

协议 fixture 与本地 fake WebSocket 全链路已验证。真实钉钉连接待部署者提供企业内部应用凭证后执行；此项不阻塞离线测试验收。
