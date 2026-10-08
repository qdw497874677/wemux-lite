# Next 模型选择（部分验收）

主会话实现。后端升级兼容问题已通过独立复审（OK with notes），Next 操作已接入并通过桌面、手机浏览器行为检查，UI 增量经修复后已通过独立复审（OK with notes），两项 P1 已关闭。Ticket04 和整体迁移仍为部分完成。

## 行为边界

- Server 接收 `set_model` 不提前修改 Session，不把旧模型写进请求指纹。相同命令重试仍检查当前权限，但不因能力列表或 Session 投影变化而改变原请求身份。
- Worker 验证新请求的可用模型，将选择持久化并记录 `model.changed`。不向正在执行的原生进程发送改模命令。
- 消息出队时在同一持久化事务内固定 Turn 的 `modelId`，`turn.started` 同步携带它。运行时只按该快照启动；选择变化作用于后续 Turn。新进程复用相同 Session 的原生上下文引用。旧记录缺少字段与显式 null（Agent 默认）区分处理。
- Server 按有序 Journal 更新 Session 选择。新增 SQLite 升级迁移解除 Session 当前模型与历史 Run 启动模型相等的错误约束，仍保留 Run 请求/快照不可变及 Task、Workspace、Worker、Agent 来源约束。
- 修复全量回归中暴露的历史测试夹具：创建 Session 补 requestId；复用候选不复制创建幂等身份；CLI 路径相对测试模块解析；迁移夹具恢复历史视图和正确版本，而非只删除最新版本号。

## 验证

原始日志：`/tmp/wemux-parent-model-fix/`。

- Server 请求重试及运行中改模回归先红后绿，聚焦 7/7。
- Worker 运行中改模回归先红；补充 claim 后、native launch 前的阻塞竞态，固定当前 Turn 模型；重试、能力撤销、SQLite 重开、相同原生上下文引用均有断言。
- Run Session 收到模型 Journal 原先因 `Invalid Session source` 失败；迁移后通过，并验证旧库升级、重复事件、重开以及 Run/Agent 不可变拒绝。
- 最终 Server 全量 **633/633**；Worker **376 通过、4 跳过、0 失败**（总数 380）。日志 `server-all-final.log`、`worker-all-final.log`。
- Server/Worker typecheck 通过：`typecheck-final.log`；packages 构建通过，`git diff --check` 通过。

可重复：

```sh
npm run build:packages
npm test --workspace @wemux/server
npm test --workspace @wemux/worker
npm run typecheck --workspace @wemux/server --workspace @wemux/worker
```

## 旧命令升级兼容修复

首轮审查 `35f36096-6816-4338-b0fd-f0df82a10def` 为 BLOCK：旧命令的 Server 注入 `previousModelId` 导致升级后原请求指纹冲突；旧 pending 命令已产生的乐观模型投影在拒绝后残留。

- 旧库回归先红：四项中两项失败，分别为 `Conflicting commandId` 和错误残留 `test-next`。原始日志 `legacy-red.log`。
- 重试只剥除旧命令中的 Server 保留字段来比较调用者完整意图；匹配后使用原始持久化命令，保留 wire 与 fingerprint，不重写已投递载荷。新请求禁止注入该保留字段；当前权限检查仍先于重试。
- 新增独立升级迁移 `legacy-model-selection.ts`：仅对带旧字段的 pending 模型命令所涉及 Session 对账，使用已连续接收的最新 `model.changed`；没有此类事件时恢复最早待决命令前的选择。不在拒绝回执上执行回滚，避免晚到或重复拒绝覆盖升级后的确认选择。
- 旧库重开测试覆盖原体重试、改模型/operationId 冲突、权限撤销、保留字段注入拒绝、已有同值/异值确认，以及升级后新确认与重复旧拒绝。命令原始持久载荷保持不变。
- 修复后 Server 全量 **638/638**，Server typecheck 通过：`legacy-server-all.log`、`legacy-types-final.log`。Worker 未修改，仍沿用此前 376 通过、4 跳过的结果，不宣称此次重新执行。

## 旧命令链第二轮修复

复审 `e53f9ab0-6734-4e72-958c-6465a62a6fd5` 关闭原指纹问题，但发现取消后迟到回执以及拒绝前驱、待决后继两种升级状态遗漏。

- 三项新回归先红两项：已取消命令未恢复；已拒绝前驱使后继的 `previousModelId` 携带从未确认的推测值。日志 `legacy-chain-red.log`。
- 追加 migration37（`legacy-model-chain.ts`），不修改已存在迁移：涉及 pending/cancelled 的旧 Session，缺少连续模型确认历史时使用整个保留旧命令链的起始选择，而非首条仍 pending 的前值；最新连续确认仍优先。命令载荷及指纹不变，不增加回执回滚。
- 旧库夹具执行 migration36→37，覆盖前一版迁移的错误中间结果。聚焦 15/15，Server 全量 **641/641**，类型检查与 diff 检查通过。日志 `legacy-chain-green.log`、`legacy-chain-server-all.log`、`legacy-chain-types.log`。原审查代理后续复核为 OK with notes，关闭旧命令链相关 P1，不表示整票完成。

## Next 操作与浏览器验证

- 共享客户端增加 `select-model` 持久控制意图，通过既有鉴权 transport 发出固定 commandId/modelId。与停止、取消、审批共享未解决槽；刷新不自动发送，显式重试不替换原模型。当前账号、作用域、写权限和归档状态仍在发送时检查。
- 模型清单按当前 Team/Worker/Agent 过滤，要求在线、可执行且支持切换；固定 Pi Provider 模型不开放切换。清单仅作发现建议，Server/Worker 仍为最终校验。
- 页面区分 Session 已确认选择和 Turn 启动时模型；旧历史缺失与显式 Agent 默认值分别显示，不从 Session 当前值推断历史模型。
- 浏览器先红后绿：嵌套 label 的文本包含 select 选项，精确标签不能定位；改为独立 label 与 useId 关联。保留唯一标签断言，不绕开语义定位。
- 共享客户端 **208/208**，Next **153/153**，两者 typecheck 通过。日志 `/tmp/wemux-parent-model-ui/{client-final,next-final,types-final}.log`。
- 真实 Chromium 桌面/手机控制验收 **26 项通过**，证据 `/tmp/wemux-next-controls-browser-g2ZQ1n/`，命令为 `apps/e2e/next-controls-browser.mjs` 配合下列环境：

```sh
PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
WEMUX_NEXT_TEST_DIST=/tmp/wemux-parent-model-ui/next-dist \
./node_modules/.bin/tsx apps/e2e/next-controls-browser.mjs
```

覆盖模型响应丢失、整页刷新零自动 POST、归档禁止重试、原体重试只保留一个命令、HTTP 接收不改确认选择，以及有序 Worker Journal 才更新选择。浏览器使用合成 Worker 事件经过生产投影器，不是真实原生执行。截图未作视觉签字。

## UI 审查拒绝恢复修复（待复审）

UI 首轮审查 `d46c4106-1d1c-455c-9ea2-4846889288d0` 为 BLOCK：模型清单过期导致明确拒绝，却永久占用共享控制槽。已由主会话修复：

- Server 仅在事务内确认没有已存命令、且因模型不可用或不支持切换拒绝新请求时返回 `409/model_not_admitted`。已有命令仍先走原身份重试，普通冲突、鉴权失败、网络异常不能作为释放依据。
- 客户端只认可模型操作的这一专用响应，在当前鉴权 port 生命周期内记录拒绝证明，显示明确原因；必须显式点击“释放未接收的模型请求”，重新核验当前权限、持久身份及存储删除成功，才解除控制槽。
- 拒绝证明不持久化。整页刷新后仍保留原意图且不自动发送，需显式原体重试重新确认拒绝后才能释放；丢响应及普通错误继续保持不确定身份。
- 单元回归先红 3 项，修复后聚焦 32/32；Server 专用拒绝码测试先红后绿，聚焦 15/15。
- 全量共享客户端 **211/211**、Next **153/153**、Server **641/641**；三者 typecheck、packages 构建和 diff 检查通过。日志 `/tmp/wemux-model-rejection/`。
- 桌面/手机真实 Chromium **28 项通过**，证据 `/tmp/wemux-next-controls-browser-25ZaL1/`。新增清单发现后撤销模型、拒绝零持久命令、刷新无自动 POST、原体复核拒绝、显式释放后真实停止请求成功；原丢响应重试场景仍通过。初跑末尾计数断言仍将拒绝 POST 当已入队，已改为单独证明拒绝命令不存在，其他已接收命令仍逐项对账。

## 迟到请求拒绝记录修复（复审通过）

复审 `393d5488-82a7-4e6d-882f-1e834895ca1c` 指出前一版拒绝只证明事务当时没有命令，不能阻止更早超时请求迟到后入队。现已修复为持久拒绝记录：

- 新增 append-only migration38 `command-rejections.ts`，记录全局 commandId、Worker 和完整请求 fingerprint。拒绝记录不进入 Worker 命令队列，不允许更新、删除或与同 ID 可投递命令并存；不设置自动到期。
- 模型拒绝在鉴权、Task 可写检查及完整身份校验之后提交记录，事务成功提交后才返回专用拒绝码。后续同身份请求永久返回未接收；变更载荷或不同操作复用身份不能入队。已有被接收命令继续走既有原体重试，不产生拒绝记录。
- 回归显式挂起早先请求 A，撤销模型后让 B 拒绝，再恢复模型并释放 A；A 仍被拒绝，数据库重开也保留记录，新 commandId 可重新选择。测试先红后绿，另断言直接存储插入同 ID 命令失败，以及拒绝记录不可更新/删除。
- 新迁移揭示旧升级夹具只删版本标记而保留新表，已修正这些夹具的历史 schema 恢复。Server 全量 **642/642**，追加存储防护断言后聚焦 **16/16**，Server typecheck 与 diff 检查通过。原始日志 `/tmp/wemux-model-fence/`。
- 桌面/手机浏览器再次 **28 项通过**，`/tmp/wemux-next-controls-browser-mFGAvN/`。客户端/UI 此轮未修改，沿用前轮测试记录，不声称重新执行其全量测试。

最终只读复审 `23d0de55-0860-45cd-bfb1-6ec124554ed3` 为 **OK with notes**，未发现新的问题，关闭模型拒绝锁槽与早先不确定请求迟到入队两项 P1。此结论仅覆盖模型选择增量；永久拒绝记录的后续保留策略不得取消原身份保护。

## 未验证及剩余

Worker 使用真实 WorkerRuntime/SQLite 搭配 fake native adapter；没有发起付费模型调用，不证明真实 Pi/Claude 恢复上下文或模型响应能力。双宿主入口、真实 Runtime 验收尚未完成。4 项跳过不计为通过。历史 Run 启动快照与实际 Turn 执行快照含义不同，不以 Session 最新选择改写历史 Run。
