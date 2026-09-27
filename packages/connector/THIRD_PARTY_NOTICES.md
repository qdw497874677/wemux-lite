# Third-Party Notices

本文件记录 `@wemux/connector` 中直接复制并修改的第三方代码。仅借鉴接口形状、设计原则或独立重写的内容，不应误记为逐行复制；若无法确认，应按包含第三方代码处理并保留声明。

## Apache License 2.0 来源记录模板

为每组来源文件复制以下小节并填写全部占位项。不得删除上游文件内已有的版权头与许可证头。

```md
### <组件或机制名称>

- 上游项目：`<owner/repository>`
- 上游仓库：`<https://...>`
- 上游许可证：Apache License 2.0
- 上游 revision：`<commit SHA 或 release tag>`
- 获取日期：`<YYYY-MM-DD>`
- 上游版权声明：`<按上游 NOTICE 或源文件原文填写>`
- Wemux 落点：
  - `<packages/connector/src/...>`
- 原文件：
  - `<上游仓库内相对路径>`
- 使用方式：复制并修改 | 部分复制并修改
- 改动说明：
  - `<改名、类型收紧、删除运行时分支、接入 Wemux 端口等>`
  - `<安全修复、默认值变化、错误码映射等>`
- 未复制内容：
  - `<明确说明未带入的框架、WebCrypto、平台兼容层等>`
- 对应测试：
  - `<测试路径与覆盖范围>`
- 本地复核人和日期：`<name, YYYY-MM-DD>`
```

## 计划来源清单

以下条目只是 G42 来源占位，不表示代码已经复制。实际搬代码时必须补齐 revision、版权、改动说明和测试后，才能把“状态”改为“已纳入”。

### Secret codec

- 状态：未纳入，仅预留来源记录
- 上游项目：`open-connector`
- 上游仓库：`/opt/data/profiles/hacker/workspace/project/connector-upstream/open-connector`
- 上游许可证：Apache License 2.0
- 上游 revision：`<填写 commit SHA 或 release tag>`
- 获取日期：`<YYYY-MM-DD>`
- 上游版权声明：`<从上游 LICENSE、NOTICE 和源文件版权头复制>`
- Wemux 落点：
  - `packages/connector/src/secret-codec.ts`
- 原文件：
  - `src/server/secrets/secret-codec.ts`
  - `src/server/secrets/secret-codec-core.ts`
- 使用方式：`<复制并修改 | 部分复制并修改>`
- 改动说明：
  - `<采用 enc:v2、随机 salt、AAD、keyId 和显式迁移入口>`
  - `<删除 WebCrypto 或明文自动兼容路径>`
- 未复制内容：
  - `<填写>`
- 对应测试：
  - `packages/connector/src/secret-codec.test.ts`，`<补充实际路径>`
- 本地复核人和日期：`<name, YYYY-MM-DD>`

### Guarded fetch 与地址策略

- 状态：未纳入，仅预留来源记录
- 上游项目：`open-connector`
- 上游仓库：`/opt/data/profiles/hacker/workspace/project/connector-upstream/open-connector`
- 上游许可证：Apache License 2.0
- 上游 revision：`<填写 commit SHA 或 release tag>`
- 获取日期：`<YYYY-MM-DD>`
- 上游版权声明：`<从上游 LICENSE、NOTICE 和源文件版权头复制>`
- Wemux 落点：
  - `packages/connector/src/guarded-fetch.ts`
  - `packages/connector/src/egress-address-policy.ts`
- 原文件：
  - `src/core/guarded-fetch.ts`
  - `src/core/request.ts`
- 使用方式：`<复制并修改 | 部分复制并修改>`
- 改动说明：
  - `<裁剪 proxy/provider 逻辑>`
  - `<加入部署与 Connector 私网双开关、永久阻断范围和 Wemux 上限>`
- 未复制内容：
  - `<填写>`
- 对应测试：
  - `packages/connector/src/guarded-fetch.test.ts`，`<补充实际路径>`
- 本地复核人和日期：`<name, YYYY-MM-DD>`

### 安全摘要器

- 状态：未纳入，仅预留来源记录
- 上游项目：`open-connector`
- 上游仓库：`/opt/data/profiles/hacker/workspace/project/connector-upstream/open-connector`
- 上游许可证：Apache License 2.0
- 上游 revision：`<填写 commit SHA 或 release tag>`
- 获取日期：`<YYYY-MM-DD>`
- 上游版权声明：`<从上游 LICENSE、NOTICE 和源文件版权头复制>`
- Wemux 落点：
  - `packages/connector/src/safe-summary.ts`
- 原文件：
  - `src/server/actions/run-log-summary.ts`
- 使用方式：`<复制并修改 | 部分复制并修改>`
- 改动说明：
  - `<拆分 Agent 输出检查与 Journal 摘要 profile>`
  - `<扩展敏感键、token 形态、getter/prototype 和大小限制测试>`
- 未复制内容：
  - `<填写>`
- 对应测试：
  - `packages/connector/src/safe-summary.test.ts`，`<补充实际路径>`
- 本地复核人和日期：`<name, YYYY-MM-DD>`

## 发布前检查

1. 上游 revision 必须是不可变 commit SHA 或明确 release tag。
2. 每个 Wemux 落点都能追溯到一个或多个原文件。
3. 改动说明必须描述安全语义变化，不能只写“适配项目”。
4. 被复制源文件原有版权头和许可证头仍保留。
5. 仓库的 Apache-2.0 许可证文本与上游 NOTICE 要求已满足。
6. `npm pack` 后本文件随 `@wemux/connector` 包发布。
