# 02: 工具执行网关的 allowedTools 与资源绑定强制

**What to build:** 工具执行网关在现有能力令牌校验之后，强制校验能力声明的 allowedTools 与资源绑定。协调会话调用白名单之外的操作、或使用与当前 project / workspace / worker / connector / connectorRevision / toolName 不匹配的令牌时，请求被拒绝且不产生任何外部副作用，并留下可复查的审计记录。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] allowedTools 之外的工具调用被拒，返回明确错误码，不执行外部调用
- [ ] 资源绑定不匹配（跨 project、跨 workspace、跨 worker、connectorRevision 过期、toolName 不符）被拒
- [ ] 伪造或过期的能力令牌被拒
- [ ] 拒绝路径不产生外部副作用（无连接器调用、无文件写入、无进程）
- [ ] 每次拒绝记录主体、操作、范围与原因码
- [ ] 合法只读调用（查询、搜索、计划）不受影响，现有 worker 测试全绿
- [ ] 负例测试与断言输出作为证据留存
