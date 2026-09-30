# R3 Pi Provider 进程物化合同（设计，未实施）

状态：设计合同。当前 Worker 只派发非秘密 `model-provider` locator，并在本机验证环境变量或加密凭据是否可解析；即使有凭据也只报告 `credential-required`。以下步骤不能当成已交付的模型探测或真实 Turn。

## Pi 实际配置边界

当前 Pi 文档 `docs/models.md`、`docs/configuration.md` 说明：Pi 内置 provider 可读取对应进程环境变量；兼容端点需要 agent directory 内 `models.json` 配置 `providers.<name>.baseUrl`、`api`、`models`，`apiKey` 可以引用 `$NAME`，不能只靠环境变量自动生成模型。Pi 的 credential 优先级是运行时 `--api-key`、`auth.json`、`models.json`、provider 环境变量；只设置环境变量不能保证选用该 key。`PI_CODING_AGENT_DIR` 可改变整套用户级 Pi 配置（包括 auth、settings、extensions、skills、instructions）；直接改为临时空目录会丢失正常 Pi 功能，直接改写原目录会覆盖用户凭据/模型。

当前 Worker `AgentTurnInput` → `WorkerAgentRunner` → `RuntimeSessionManager` → `RuntimeSessionAdapter` 是持久 Session 生命周期，不是每条 Turn 新进程。`apps/worker/src/application/agent-launch-context-provider.ts` 目前只准备 Skill/connector capability；`apps/worker/src/application/cluster-lifecycle.ts` 已将 `ResourceReconciler` 与本地凭据 owner 连接，但本机独立模式不应隐式继承集群资源绑定。必须在进程创建之前按 Project、Agent、modelId 选定恰好一条有效 binding；同一 Agent 有多个 Provider 时须按模型 ID 消歧，不能将全部凭据注入整个 Worker 或全部 Agent 子进程。

## 待实施的两段验收

1. **内置 Pi Provider**：只对明确有原生环境变量的 provider 实施。先冻结 providerKey→Pi provider/model/受支持变量映射及冲突策略（不从 Server 任意变量名推断任意内置 provider），选择 project 作用域优先于全局，验证 desired revision、binding.Agent 和所选 `modelId` 匹配。执行前重新从 Worker 本地 owner 解密或读取环境；没有本地配置、变量不匹配、撤销、重复绑定、已有更高优先级 Pi 认证冲突时拒绝新 Turn，不能无声回退到另一账号。凭据仅传给该 Agent 子进程；不写 session/journal/report/capability snapshot/配置文件。`get_available_models` 检查所选模型是否列出，响应字段经严格过滤。此检查仅证明 Pi 报告模型，并非实际 API 成功；真正 ready 需经授权的低成本真实请求或同等强度认证探测，错误区分 credential-missing、auth-failed、runtime-unavailable、network-failed。轮换/撤销令已存活 Session 停止复用旧进程，在下一 Turn 重新解析并重建进程；不可改变正在进行的 Turn。
2. **自定义 HTTPS 兼容端点**：确定官方包版本与 Pi `models.json` schema，按不可变 revision 生成无秘密内容的受限模型定义（固定 `api`，禁止额外 headers/命令/literal key，`apiKey` 只用 `$NAME`），不能从 `providerKey` 直接猜 `api`。为启动的 Pi 子进程隔离 agent directory 时显式保留受信 settings/extensions/skills/auth 的语义，或经产品决定禁用继承并给出 UI 提示；切勿覆盖用户原目录。原目录仅允许只读读取，经白名单拷贝/合并；临时目录权限 0700，进程退出和崩溃后清除，不写明文 secret。Pi 文档说明 `models.json` 的 `!command` 会在请求时执行，所以绝不可让 Server 配置自由写入。先通过离线假 Pi 测试路径/ACL/原有配置保留，再用受控假 HTTPS endpoint 验证 JSON/RPC/注销与重连。

## 安全和回归门槛

严格避免 `launchContext.environment` 中通用 WEMUX 变量与 Provider key 合并产生覆盖；敏感环境的生命周期必须绑定 **Agent Session 的进程创建/释放**，不能仅在 Turn 中重置 JS 对象。测试覆盖 project/agent/model 选择冲突、Secret 命中其他 Agent、错误密钥/撤销后的下一 Turn、运行中轮换、失败重试、重连与冷启动、用户 Pi 配置不被修改、日志/SQLite/Server wire 无 key，以及进程意外退出的临时目录回收。所有真实模型请求须先取得计费与凭据使用授权。未通过这些门槛时 Provider 保持 `credential-required`，不声称 `ready`。
