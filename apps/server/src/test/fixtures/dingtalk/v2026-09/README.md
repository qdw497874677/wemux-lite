# 钉钉 Stream 协议夹具 v2026-09

来源：钉钉开放平台 Stream 模式文档与 `open-dingtalk/dingtalk-stream-sdk-nodejs` 2.1.6-beta.1 协议实现。

抓取日期：2026-09-01（票据要求的版本化日期）。夹具已删除企业、人员和凭证信息，仅保留协议字段形状。

- `private-text.json`：单聊文本机器人回调，topic 为 `/v1.0/im/bot/messages/get`。
- `group-mention.json`：群聊中 @ 机器人文本回调。
- `unsupported-image.json`：不支持的图片消息，用于验证 ACK 后审计忽略。

WebSocket 帧外层使用 `specVersion/type/headers/data`；回执复用请求 `messageId`，`type` 为 `SYSTEM`，`headers.contentType` 为 `application/json`，`data` 为 JSON 字符串。
