# R3 Worker 凭据引用与期望态检查（局部完成）

`model-provider` 不可变 revision 的非秘密 `credential` 现同时允许 `{kind:"environment",variableNames:[...]}` 和 `{kind:"worker-credential",credentialRef,variableNames:[...]}`。`credentialRef` 是 Worker 本地密文表的 ID，不是 Worker 集群注册凭据；Server 只保存/派发 ID 和字段名，不拿到密钥或密文。严格校验 endpoint HTTPS、ref、字段名和禁止未知嵌套字段，Provider 配置内容哈希由 Server 检查，Worker 收到 desired set 后再校验；不开放 vault-ref。

Worker 每次 reconcile 根据 locator 检查指定环境变量或本地 `model-provider` owner 是否可以用现有密钥解析，字段必须匹配，缺失/密钥失效/撤销/篡改均报告 `credential-required`，诊断不含 Secret。**能解析凭据不是模型探测，也不代表 Agent 可用，永远不在本切片报告 `ready`**。本地管理员通过 `/api/local/providers/credentials` 安全录入，集群管理员不能借资源列表接口读取密文。当前没有把 Secret 注入 Agent 子进程；新 Turn 不会使用 Provider 配置，属于下一切片。

测试覆盖 domain revision、Server Preset 下发两种 locator、wire strict parse、Worker 本地 owner 字段匹配/撤销/密钥错误与不泄漏断言。回归运行：`npm run build:packages`、`npm run typecheck` 通过；`npm test` 通过，Node 844 tests / 838 pass / 0 fail / 6 skipped，package 10 pass，Web 290 pass，日志 `/tmp/provider-locator-full-test.log`。
