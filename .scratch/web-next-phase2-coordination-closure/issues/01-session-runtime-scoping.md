# 01: 会话级运行环境作用域

**What to build:** 协调 Session 的 Agent 进程拥有落在会话工作区内的独立 home/配置目录，进程环境不继承 Worker 的宿主凭据，工作目录限定在会话工作区。用户在协调会话里发起对话时，Agent 的配置与状态只写入会话工作区，不污染宿主全局 Agent 配置，也不拿到 Worker 进程里的其它凭据。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] 协调 Session 的 Agent home/配置目录位于会话工作区内，可在进程启动边界观测到
- [ ] 进程环境只含该 Session 的模型 Provider 变量，不含宿主凭据环境（负例断言：注入标记变量不出现在子进程）
- [ ] Agent 进程工作目录为会话工作区，相对路径操作不落到工作区之外
- [ ] 作用域对全部有效 Runtime 的启动路径生效（pi / claude / opencode），不只是 Pi
- [ ] 普通（非协调）Session 行为不变，现有测试全绿
- [ ] 断言与命令输出作为证据留存（原始证据留 `.scratch/`，脱敏摘要入 `docs/acceptance/`）
