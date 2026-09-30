# R3 Model Provider 环境变量引用切片（部分）

状态：仅完成无秘密配置、发布/传输校验、Preset 绑定和 Worker 环境变量存在性提示；**不表示模型可用或 Provider 已接入 Agent**。

- `model-provider` 定义仅接受 HTTPS endpoint、模型 ID、Agent 映射与 `environment.variableNames`。资源和不可变 revision（含 manifest/compatibility/supplyChain）的额外字段、URL 内用户名/密码、明文凭据均拒绝；Server 仓储验证发布配置的真实 SHA-256，期望态通过严格 wire 结构传递；Preset 只能绑定定义允许的 Agent。
- Worker 验证期望态 hash、结构和环境变量名称；缺失或仅存在时均报告 `credential-required`，存在性并非授权或模型探测，也从不报告 `ready`。环境变量值不进入 Server、资源状态文件、wire report。环境变量应仅在 Worker 受信任进程本地配置，不能放入 Server 资源 JSON。
- 回归：`npm run build:packages`、`npm run typecheck`；Provider 所在的定向组合 31 个测试及 domain 4 个通过。首次 `npm test` 遇 Pi RPC 测试只等文件出现便解析的竞态，补最小复现并修复后该套件 29/29 通过；第二次全量偶发 R1 两 Worker E2E 注册 exit 1，原测试丢失 stderr，现增加对 Token 脱敏的诊断，尚未捕获根因。修补 manifest/supplyChain 嵌套字段校验后再次 `npm test` 通过：Node 840 tests / 834 pass / 0 fail / 6 skipped，package 10 pass，Web 290 pass，日志 `/tmp/r3-test-after-manifest.log`；最终类型检查日志 `/tmp/r3-typecheck-after-manifest.log`。Provider 测试含明文 sentinel 的 HTTP 拒绝、仓储约束/不可变性、wire 严格解析、Preset 映射、Worker 缺失/存在值 fail-closed 且报告/状态不含 sentinel。R1 注册偶发另设待办，不视作已修复。

后续 R3 独立切片：Worker 本地凭据 owner 与 `SecretCodec`、轮换/撤权；Provider 物化与针对 Agent 的**最小**启动环境、模型能力探测；Web 本地配置引导；双 Worker（一个 environment、一个 worker-credential）真实模型端到端验收。未有真实 Vault adapter 不开放 Vault；任何模型调用前须确认计费授权。Server 管理员不能读取 Worker Secret。当前切片不可替代上述工作，也不能用 Test Agent 的 Session Turn 当作模型探测。
