# Third-Party Notices

本文件记录 `@wemux/connector` 中直接复制并修改的第三方代码。

## oomol-lab/open-connector

- 上游项目：`oomol-lab/open-connector`（包名 `@oomol-lab/open-connector`）
- 上游仓库：<https://github.com/oomol-lab/open-connector>
- 上游许可证：Apache License 2.0
- 上游 revision：本地来源快照未包含 `.git` 元数据且版本为 `0.0.0-development`，因此以下条目以原文件 SHA-256 固定所用快照
- 获取日期：2026-09-27
- 上游版权声明：`Copyright 2025 OOMOL Corporation.`
- 上游 NOTICE：`OOMOL Connect is licensed under the Apache License, Version 2.0, except where otherwise noted.`

### Guarded fetch 与地址策略

- Wemux 落点：
  - `packages/connector/src/guarded-fetch.ts`
  - `packages/connector/src/egress-address-policy.ts`
- 原文件：
  - `src/core/guarded-fetch.ts`
  - `src/core/request.ts` 中 URL、IPv4/IPv6 与 egress 地址分类部分
- 来源 SHA-256：
  - `src/core/guarded-fetch.ts`: `e945d6df1e1a3dbd1ca615e7469702a7fdca47eb67388dc7d30a5395db0d7e93`
  - `src/core/request.ts`: `9bed7c9b9ae0490bd6a914d9b4be789b7b15c19be6f0004a6918b7917c1659a7`
- 使用方式：部分复制并修改
- 改动说明：仅保留 Node `node:dns` 路径；默认 redirect 上限改为 5；私网放行改为部署级与 Connector 级双开关；保留 URL 字面量、每跳 redirect、DNS 全地址失败关闭、跨 origin header deny-by-default 和永久阻断范围。
- 未复制内容：Cloudflare/workerd 兼容分支、OOMOL 全局 trusted-host 例外、provider request/query/body helpers、WebSocket/pinning 调用方和全局可变配置函数。首版契约明确不支持 split-DNS trusted-host 例外。
- 对应测试：`packages/connector/test/guarded-fetch.test.ts`。

### Secret codec

- Wemux 落点：`packages/connector/src/secret-codec.ts`
- 原文件：
  - `src/server/secrets/secret-codec.ts`
  - `src/server/secrets/secret-codec-core.ts`
- 来源 SHA-256：
  - `src/server/secrets/secret-codec.ts`: `d5e6ab53accbd7bdfc4d7f058f71e48eb2c97e5a3bf335820c88ba05312a70c4`
  - `src/server/secrets/secret-codec-core.ts`: `3b87303a54505a4b21d928d4cb88f3dbb572bd3833883ab8829b8844bcda45c6`
- 使用方式：部分复制并修改
- 改动说明：从固定 salt `enc:v1` 收紧为每记录随机 16 字节 salt 的 `enc:v2`；增加 keyId、多 key 读旧写新、固定 scrypt 参数与绑定 owner/credential/authType/revision 的 GCM AAD；旧格式只允许显式迁移。
- 未复制内容：缺 key 时自动创建 plaintext codec、正常 decode 自动接受无前缀明文、WebCrypto 版本和固定 salt 正常写路径。
- 对应测试：`packages/connector/test/secret-codec.test.ts`、`packages/connector/test/dependency-boundaries.test.ts`。

### 安全摘要器

- Wemux 落点：`packages/connector/src/safe-summary.ts`
- 原文件：`src/server/actions/run-log-summary.ts`
- 来源 SHA-256：`26d33eb15d466e1aed219c638b24669eafd24a27d6f782ad0cc081b7deee2401`
- 使用方式：部分复制并修改
- 改动说明：保留敏感键、Basic/Bearer、JWT、敏感 URL、getter/prototype 防护与有界遍历；拆分 `agentResult`（256 KiB、100,000 节点、深度 32）和 `journalSummary`（16 KiB、256 节点、深度 4、字符串 256）两个 profile。
- 未复制内容：上游 `ExecutionResult` 错误文案映射和 provider action 专用错误码。
- 对应测试：`packages/connector/test/safe-summary.test.ts`。

Apache License 2.0 全文见上游 `LICENSE.txt` 或 <https://www.apache.org/licenses/LICENSE-2.0>。上游 NOTICE 还说明第三方 provider/app 的名称、商标、图标、API 与品牌资产仍归各自所有者，引用仅用于识别与互操作，不表示背书或合作。
