# 连接器模块 G42 统一验收证据格式

状态：后续 G43、G44、G45、G46 的验收基线

日期：2026-09-27

契约来源：[connector-module-contracts.md](../design/connector-module-contracts.md)

## 1. 使用规则

1. 每个后续阶段必须保存可重复执行的测试命令或浏览器脚本，原始日志、数据库快照和截图放 `.scratch/connector-module/<ticket>/` 或 `/tmp`，不得提交凭证和真实平台标识。
2. 随规格提交脱敏摘要。摘要必须区分“已实现”“自动化已验证”“真实浏览器已验证”“真实第三方平台已验证”“受环境阻塞”。
3. 源码契约扫描只能补充行为测试，不能替代授权、重试、重启、撤权、浏览器和协议 fixture 验收。
4. 每条证据必须写明代码 revision 或工作树状态、执行时间、Node 版本、命令、退出码、关键断言和原始证据路径。
5. 失败日志中若出现测试 Secret sentinel，必须视为安全测试失败，不得仅做日志遮盖后通过。

## 2. 阶段验收摘要模板

```md
# <G43|G44|G45|G46> <切片名称> 验收摘要

## 范围

- 契约条目：<connector-module-contracts.md 章节>
- 实现路径：<路径列表>
- 不在本次范围：<明确列出>

## 环境

- 日期：<UTC 时间>
- Git：<commit 或 working tree 摘要>
- Node：<版本>
- OS：<版本>
- Server/Worker 启动参数：<脱敏值>
- 第三方 fixture 或平台：<名称与版本>

## 自动化结果

| ID | 类型 | 命令 | 退出码 | 关键断言 | 原始证据 |
|---|---|---|---:|---|---|
| T-001 | unit/integration/e2e/scan | `<command>` | 0 | `<assertion>` | `<path>` |

## 浏览器结果

| ID | 场景 | 脚本 | 浏览器 | 关键观察 | 截图/trace |
|---|---|---|---|---|---|
| B-001 | `<scenario>` | `<script>` | Chromium `<version>` | `<observation>` | `<path>` |

## 安全反例

| ID | 攻击前提 | 操作 | 预期拒绝或不可得事实 | 实际结果 | 原始证据 |
|---|---|---|---|---|---|
| S-001 | `<premise>` | `<steps>` | `<negative assertion>` | PASS/FAIL | `<path>` |

## 状态结论

- 已实现：<列表>
- 自动化已验证：<列表>
- 真实浏览器已验证：<列表或“无 UI 变更”>
- 真实第三方平台已验证：<列表或“仅 fixture，原因”>
- 受环境阻塞：<列表与解除条件>
- 已知限制：<不得削弱冻结契约>
```

## 3. 自动化测试条目模板

```md
### T-<编号> <名称>

- 目标契约：`docs/design/connector-module-contracts.md §<章节>`
- 层级：unit | integration | protocol-fixture | e2e | source-scan
- 前置数据：<定义、授权、凭证状态、revision>
- 操作：<单一可重复命令>
- 正向断言：<状态、记录、输出>
- 反向断言：<不得发生的副作用、泄漏或重复>
- 重启断言：<需要时写 Server/Worker 重启后的事实>
- 清理：<动态端口、临时目录与进程组>
- 原始证据：<日志路径>
```

最低覆盖集合：

1. 每种实体判别分支的解析与未知字段拒绝。
2. 每个 `ConnectorExecutionErrorCode` 至少一个产生场景。
3. A3 Project、Worker、Session、`allowedConnectorIds` 每个维度单独撤销的失败关闭。
4. operationType 的 HTTP 方法、MCP annotation 缺失/冲突/恶意降级。
5. 审批矩阵每个失败关闭单元格。
6. 同 requestId 同 fingerprint 重放、同 requestId 异 fingerprint 冲突、CAS stale revision。
7. 所有大小、深度、数量、超时和 redirect 边界的等于上限与超过上限。
8. MCP 崩溃、退避、熔断、空闲回收、cancel、Worker shutdown 后无孤儿进程。
9. webhook 重复、ACK 丢失、Server 重启、binding 撤权和 outbox 死信/重放。
10. 密钥缺失、错 key、篡改 tag、轮换中断、旧明文正常执行路径拒绝。

## 4. 浏览器验收条目模板

```md
### B-<编号> <名称>

- 页面入口：<URL 路由>
- 账号角色：owner | manager | contributor | viewer
- Worker/Session：<脱敏 ID 与状态>
- 初始状态：<定义 revision、credentialAvailability、授权>
- 操作步骤：
  1. <步骤>
  2. <步骤>
- 可见结果：<中文 UI 状态、错误码映射、重试状态>
- 不可见事实：<Secret、ciphertext、Authorization 值不得出现在 DOM、网络响应、localStorage、日志>
- 后端交叉检查：<数据库记录或 API 安全投影>
- 证据：<Playwright 脚本、trace、截图路径>
```

浏览器验收必须使用动态端口。集群 Web 验证 Worker Connector 时，不得出现 Secret 输入框；Worker 本地工作台可以录入 Worker Secret，但网络请求目标必须是 Worker 本地控制面，不得经过 Server。

## 5. 安全反例条目模板

```md
### S-<编号> <攻击目标>

- 攻击者能力：<例如只取得 server.sqlite 与 Server 文件系统只读副本>
- 保护资产：<例如 Worker HTTP API key>
- 准备：<植入唯一 sentinel，不使用真实 Secret>
- 攻击步骤：<可重复命令>
- 必须不可得：<精确字符串、字段或导入边>
- 允许可见：<credentialRef、availability、revision 等安全元数据>
- 通过标准：<grep/SQL/AST/运行时断言全部满足>
- 失败处置：<阻止阶段验收，不得降级为已知限制>
- 原始证据：<路径>
```

## 6. 安全反例 S-001：Server 数据库泄露不得得到 Worker 凭证

### 6.1 威胁模型

攻击者获得以下内容的只读副本：

1. `server.sqlite` 及其 WAL/SHM。
2. Server 日志、审计导出、outbox 与 wire transport outbox。
3. 集群 Web 静态资源和 API 响应抓包。
4. Server 的 connector 定义与 credential 状态投影。

攻击者未获得 Worker home、Worker 进程内存或 `WEMUX_CONNECTOR_ENCRYPTION_KEY`。

### 6.2 验证方法

1. 在 Worker 本地工作台创建一个 `api_key` 凭证，值使用 64 字符唯一 sentinel，例如 `WEMUX_WORKER_SECRET_SENTINEL_<随机后缀>`。
2. 创建引用该 `credentialRef` 的 Connector，完成一次成功测试和一次 Session 工具调用，确保所有常见数据路径都被使用。
3. 停止 Server，复制 `server.sqlite`、`-wal`、`-shm`、Server 日志、transport SQLite 和 Web 抓包到临时证据目录。
4. 对文件执行二进制安全搜索：

   ```bash
   rg -a -n -F 'WEMUX_WORKER_SECRET_SENTINEL_<随机后缀>' <证据目录>
   ```

5. 使用 SQLite 查询所有表的 text/blob 值并做同一 sentinel 搜索。不能只检查 connector 表。
6. 序列化 Server 可见的 Connector API、wire Command、receipt/report、审计条目和 Journal，逐一断言 sentinel 不存在。
7. 断言 Server 可见内容只包含允许的 `credentialRef`、`credentialAvailability`、revision 和安全错误码。
8. 在 Server 进程中尝试按 `credentialRef` 调用凭证解析接口，架构上应不存在 Worker CredentialStore 适配器；若误接入，测试必须失败。

### 6.3 通过标准

1. 所有 sentinel 搜索均为零命中。
2. `server.sqlite` 不含 Worker `CredentialRecord.ciphertext`，不仅是不含明文。
3. Server 不拥有能解析 Worker credentialRef 的接口或密钥。
4. 成功工具调用的 Agent 输出与 Journal 也不出现 sentinel。
5. 测试过程保留 Worker 数据库中的密文存在证明，但证据只记录 `enc:v2:` 前缀、keyId 和长度，不复制完整密文。

该反例失败时，G43 或 G44 不得验收。[G42 契约 §7、§11]

## 7. 安全反例 S-002：Worker 不 import server-domain

### 7.1 验证方法

增加一个源码依赖扫描测试，至少扫描：

- `apps/worker/src/**/*.{ts,tsx,mts,cts}`
- `packages/connector/src/**/*.{ts,tsx,mts,cts}`
- `apps/worker/package.json`
- `packages/connector/package.json`
- 相关 `tsconfig*.json` 的 path alias

使用 TypeScript AST 读取以下语法：

1. `ImportDeclaration`
2. `ExportDeclaration`
3. `ImportTypeNode`
4. `require()` 字符串参数
5. 动态 `import()` 字符串参数

模块 specifier 规范化后，以下形式全部必须拒绝：

```text
@wemux/server-domain
@wemux/server-domain/*
相对路径解析后落入 packages/server-domain/
file:、workspace: 或 tsconfig alias 最终指向 packages/server-domain/
```

建议测试文件名：

```text
apps/worker/src/test/connector-boundaries.test.ts
```

可重复辅助命令可以使用：

```bash
rg -n "@wemux/server-domain|packages/server-domain" apps/worker packages/connector
```

但 `rg` 只能作为快速诊断，AST 加真实路径解析才是验收断言。

### 7.2 运行时交叉检查

1. 构建 Worker 后扫描 `apps/worker/dist/` 的 import specifier 与 source map sources。
2. 打包 Worker tgz 后列出依赖，断言 package manifest 不声明 `@wemux/server-domain`。
3. 在不构建 `packages/server-domain/dist` 的隔离临时目录安装 Worker tgz并执行 Connector fixture。Worker 必须能启动并完成本地 Connector 测试。

### 7.3 通过标准

1. 源码 AST、package manifest、tsconfig alias、dist 和 tgz 均无 Worker 到 server-domain 的依赖。
2. `packages/connector` 只依赖 `@wemux/domain` 等冻结允许层，不通过间接 re-export 偷渡 Server 类型。
3. 隔离安装下 Worker 的 Connector 能力正常，证明边界不是仅靠字符串改名伪装。

该反例失败时，G43-G46 均不得验收。[G42 契约 §7、主设计 §2.3]

## 8. wire 秘密扫描证据

后续每个更改 wire 类型的阶段必须附：

```md
### S-WIRE-<编号>

- 可达根类型：ConnectorWireSnapshot、connector Command、ConnectorRevisionReport
- 禁止字段表版本：G42 §7.3
- fixture sentinel：<随机值>
- AST 扫描命令：<command>
- 序列化扫描命令：<command>
- 结果：字段命中 0，sentinel 命中 0
- 原始证据：<path>
```

禁止字段扫描必须大小写不敏感，并移除 `_`、`-` 后比较。安全例外只能是 G42 §7.3 明列的四项。

## 9. 可靠性状态表证据

H4 测试应以一行一个 delivery 的方式导出脱敏状态：

```text
identity | fingerprint_prefix | state | attempt | next_attempt_at | terminal_code | enqueue_count | push_count
```

必须证明：

1. 重复 inbound event 的 `enqueue_count` 恒为 1。
2. outbox 重试保持同一 identity。
3. 429/5xx 最多总计 6 次。
4. 永久 4xx 不重试。
5. disable 后 pending 转 cancelled。
6. Server 重启回收过期 sending 租约，不创建第二个 delivery。
7. 管理员重放增加 attempt 与审计记录，但不换业务 identity。

## 10. 脱敏要求

验收摘要和提交文件不得包含：

- API key、app secret、Authorization 值、access/refresh token
- verification token、encrypt key、bearer token
- 完整 ciphertext、passphrase、private key、cookie
- 真实用户邮箱、飞书 tenant、chat、open_id、union_id
- 本机绝对 home 路径中的用户名

允许展示：

- branded id 的测试值
- `credentialRef`
- `credentialAvailability`
- `enc:v2:` 前缀、keyId、总长度
- fingerprint 前 12 位
- 脱敏 appIdHint、错误码、revision、attempt 和时间戳
