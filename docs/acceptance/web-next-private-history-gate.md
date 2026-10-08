# Ticket03 私有 Worker 历史门前置验证

状态：仅实现非公开、root-only 的本地状态转换与持久化切片。Ticket03 和 all16 仍为部分完成，不改变 Task 删除资格。

## 机制与边界

- 显式构造独立 SQLite 数据库，拒绝已有其他用途的数据库。短同步事务原子校验并持久化 admission、prepare、release、effect reservation 与结果；不接入现有 Worker 数据库、启动、调度、Runtime、Gateway 或 Adapter。
- release 的可信测试 manifest 先导入精确 carried admissions，再推进 generation/revision。旧 prepare 不覆盖已完成 release；重复控制保持幂等，冲突及本地已知遗漏拒绝。manifest digest 仅验证完整性，不证明远程身份或远端清单完整性。
- effect 先持久化 reservation，再在事务外执行。重复返回 awaitExisting、原始结果字节 replay 或 unknown；重开数据库将未结算 reservation 转为 unknown。release 不取消义务，下一 fence 仍覆盖 carried work。
- 仅支持 `fs.write` / `root-only`；approval、child、delegation 和其他 effect coverage 拒绝。`localSubsetSettled` 只描述这一私有子集，绝不是历史删除证明。测试提供真实 awaited `writeWorkspaceFile` 临时文件写入及暂停点，不提供删除、停止或取消回调。
- 私有数据库要求单一独占生命周期所有者；重开用于恢复，不是并发第二个 owner。保守的单 Session effect 排他不替代生产 Workspace 调度。该切片不实现 unknown 的 effect-specific reconciliation、授权撤销、远端认证、恢复/部署连续性或真实 Agent/background settlement。

## 已执行验证

在仓库根执行，均退出 0：

```sh
node --import tsx --test apps/worker/test/session-history-gate.test.ts apps/worker/test/session-history-fs-effect.test.ts
npm run typecheck --workspace @wemux/worker
node --import tsx --test apps/worker/test/retention-upgrade.test.ts apps/worker/test/transport-store.test.ts apps/worker/test/connector-mcp-storage.test.ts apps/worker/test/workspace-files.test.ts
```

新测试 14/14、相关回归 20/20 通过；Worker typecheck 通过。覆盖 release 先到与持有写入只执行一次、身份/内容/绑定/epoch/digest 冲突无 I/O、运行中重试、明确 unknown、写入后结算前崩溃、跨 generation 义务、SQLite 注入失败完整回滚、重开后的幂等及拒绝不擦除历史/原文件。第二 SQLite 连接取得写锁并读到 reservation，验证 effect 前已提交事务。测试位于现有 `test/*.test.ts` 发现路径。

P2 修复仅涉及私有 fs fixture：reservation 前捕获不可变 base64 快照，fingerprint 与暂停后的 `writeWorkspaceFile` 使用同一快照。新增回归在 `beforeWrite` 暂停期间修改调用方 Buffer，验证写入原始 admitted bytes、修改后 payload 重试拒绝、原始 payload 重试 replay 且不增加 callback。以 `--test-name-pattern='caller buffer mutation'` 单跑该文件，修复前退出 1（0/1，通过实际写入修改后字节复现缺陷），修复后退出 0（1/1）；上述两个 focused 文件合跑 14/14、相关回归 20/20 和 Worker typecheck 均退出 0。修复已独立复审通过（`outputs/fa332e8f-3a67-4212-a03b-75783522eee9/tickets/03/private-fs-snapshot-rereview.md`，no issues / OK for private prerequisite only）。复审检查源码、增量 diff 和 red/green 证据，未自行重跑测试；不表示公开功能获准启用。

未运行完整 Worker 命令，因为其中含本任务禁止的 network-auth/browser 场景；未执行外部下载、Agent、根构建、部署或服务重启。初始切片证据在 `/tmp/wemux-private-history-fwqhvV/`；本次 P2 red/green 日志、退出码、前后哈希与增量 diff 在 `/tmp/wemux-private-fs-snapshot-VGYGJm/`，不作为仓库交付内容。

## 后续约束

未来 Server 关闭 approval continuation window 必须使用不可变、精确关联的报告，证明 root execution 已结束、不会再产生 approval 且没有 unresolved obligations。旧报告/新 approval 必须拒绝关闭。本次没有实现 approval 或该远端协议。生产授权、恢复与独占部署规程、真实 Agent 及其后代结算、双宿主等门槛仍未验证；私有测试不得替代这些证明。
