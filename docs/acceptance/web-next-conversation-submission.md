# Ticket 04：共享可靠消息提交增量

## 边界与状态

已实现、已做 headless 行为与受控真实 HTTP 验证，待独立 review。Ticket 04 和全 16 票仍为 partial。本增量不接入 Next/旧版 UI，不宣称浏览器、视觉、移动端、真实 Worker 或 Runtime 验收；此前 UI 的视觉阻塞不在此解除。

仅新增 `packages/web-client/src/conversation-submission.ts`、两个专用测试、本文，并最小追加 `packages/web-client/src/index.ts` 导出。未修改既有 controller/projection/transport/contract/Server/Worker/Next/legacy。不增加依赖、不使用创建 Session 的 requestId、不直接调用 crypto.randomUUID。

## 给 Next owner 的 API 交接

```ts
const submission = createConversationSubmission(
  { host, accountId, teamId, projectId, taskId, sessionId },
  { storage: () => window.sessionStorage, send: client.sendMessage },
)
const unsubscribe = submission.subscribe(onChange)
submission.load() // 仅读取；构造与 load 均不发送
submission.edit(text) // 返回 false 时显示 error，UI 不应声称编辑已持久化
await submission.submit() // 仅新意图；已有未决请求时要求显式 retry
await submission.retry() // 仅重放本实例观察到的原身份，绝不 mint
submission.dispose() // 中止本地观察并清空快照，不撤回服务端请求
unsubscribe()
```

`getSnapshot()` 返回冻结 scope、draft、intent、admission、status、中文 error。scope 是完整 host origin/accountId/teamId/projectId/taskId/sessionId 快照；实例不能换绑。账号/团队/任务/Session 变化时 dispose 旧实例、建立新实例，不删除原 scope 的存储。注入端口必须来自同一宿主和当前获权账号/团队；scope 不是权限证明，Session 的写权限仍由 Server 逐次验证。

- `unloaded → ready`：load 成功，无意图；没有隐式请求。
- `ready/admitted → sending`：submit 从已保存草稿 mint commandId/messageId，完整原文和身份持久化且读回完全相等后才发送。
- `sending → uncertain`：网络中断、dispose、任意抛出的 HTTP 错误、畸形/身份不符回执。原意图保留，submit 不能绕过，只有显式 retry 使用原 body。
- `sending → admitted`：当前固定 Session 的 POST 返回精确 commandId/messageId 和合法 command status，且确认状态持久化成功。`pending/accepted/rejected/completed/failed/cancelled` 是 **Command 接收/状态**，不是 Turn 成功。状态名 admitted 表示接收回执已验证，不把 rejected 翻译成执行成功。
- 写确认状态失败：仍保留未决 intent，快照 admission 保留这次有效回执，展示“已收到回执但无法保存确认状态”，不撒谎说从未收到。
- `blocked`：存储缺失/拒绝/损坏、原意图消失或替换等安全前置检查失败。保留已知原意图；不要用新实例或清空存储作为绕过办法。
- `disposed`：不再通知、不再发布结果，快照 scrub；abort 不是撤回。即使注入 sender 不响应 signal，局部等待也结束并释放协调，迟到结果不清除或覆盖存储。

一个 scope 只保存一条最近意图（可已确认）和一份独立草稿，不积累 outbox。已确认的 intent/receipt 保留到下一次显式 submit 替换；不会自动删除或自动发下一条草稿。未决期间可编辑新草稿，原 body 不变。确认仅在草稿 revision 和内容仍对应发送时才清空草稿；另一实例编辑、甚至内容改回原文的 ABA 编辑都保留。

## 接收与结算依据

源码依据：`apps/server/src/http/routes/session-routes.ts` 的 authenticated `POST /sessions/:sessionId/messages` 调用 `ServerService.enqueue`，返回 202；`apps/server/src/application/server-service.ts` 的 `enqueueInTx` 先检查权限、Task/Workspace 生命周期和 sendCapability，再执行 commandId/fingerprint 去重。`enqueue` 的事务提交之后还会通知并读取 command status。因此：

1. 任意 HTTP 4xx/5xx 都不能证明**原请求**从未被接收。例如响应丢失后重试可能因生命周期变化被拒绝，原 command 仍存在。所有抛出的 HTTP 错误保守保留原身份，不以 status/code 授权 mint 新身份。
2. 与原身份相符的成功 POST 回执是本增量唯一结算凭据；有效 `status: rejected` 与 HTTP rejection 完全不同，前者是已存在 command 的状态回执。它也不是 Turn 成败证据。
3. `GET /api/commands/:id` 仍为管理员专用；本控制器没有 commandReceipt 依赖、轮询、权限放宽或 Journal 确认 API。调用方不能用任意 messageId 字符串清除意图。
4. POST 身份保持精确原文（包括前后空格和换行），不会用 UI 当前草稿替换重试正文。请求对象冻结，且现有 sendMessage 自身还有 wire snapshot。

## 存储与并发边界

JSON schema 有固定 version、scopeKey、draft/revision、intent/body/receipt；拒绝未知字段、无效 ID、无效 revision、错误 scope、畸形或错误身份回执。在 JSON.parse 前限制原始长度 1300000 字符；草稿和正文限制 100000 字符、无 NUL、JSON 编码最多 200000 UTF-8 字节，与 Server 正文限制对齐。提交前 setItem/read-back，结算前核对原始存储及完整 body/draftRevision，旧结果不得删除或覆盖新意图。任何存储异常不发送新请求，不主动删除损坏数据。

同 JS realm、同 storage 对象、同完整 scope 的活动 Promise 在任何 storage/mint/send 回调前登记，覆盖身份读取到结算；同步存储操作另有重入 guard。duplicate click、另一实例、同步 callback 重入共享 flight，settlement 后释放。新实例在旧飞行未结束时加入同一操作，不另 mint。不同 scope 各自独立。

**这只是同标签页刷新持久化，不是授权、加密或跨标签页 exactly-once。** 明文草稿可被同 origin 脚本读取；必须配合账号切换 UI 生命周期，不把本地内容当服务端授权依据。关闭标签页、清除存储、浏览器丢失数据、恶意同源脚本、不同 storage 包装对象、不同 JS realm 不受该协调保证。没有跨标签页原子 CAS。已观察未决意图的实例发现记录消失/变化会阻止 submit/retry；数据清除后全新实例无法凭空找回历史身份，用户应先核对服务端历史，不能将其宣称为安全重发机制。普通用户遭遇永久权限/生命周期拒绝的未知请求可能保持 blocked/uncertain，本增量故意不提供无权威证明的“放弃并换身份”。

## 验证证据

新增 16 个 unit tests，覆盖 reload、丢响应同体重放、并发/重复点击/多点重入、in-flight draft 与 ABA、拒绝/丢弃/read-back storage failure、坏 schema、原身份删除/替换、所有 scope 维度、dispose/迟到结果、invalid/mismatch receipt、HTTP 错误与合法 rejected status 区别、只读 load 和无管理员依赖。

新增 1 个受控 public API integration test：真实 `createWemuxServer`，owned `/tmp` SQLite，动态端口，真实普通 contributor 账号 Cookie/CSRF 登录，合成 Worker capability/Workspace placement，无 Worker 进程或模型。经现有公共 cluster client 创建 Task Session 后，POST 202 被完全消费再丢给客户端网络错误；新 submission 实例 load 不 POST，显式 retry 的两次原始 HTTP body 完全一致。数据库最终只增加一个 enqueue command，内容/Session/actor 精确匹配；command 保持 pending、Session 仍 idle，不冒充执行成功。控制器零 command receipt GET；独立负向断言普通用户 GET command receipt 为 403。

实跑：

- `npm run build:packages`：通过。
- `npm test --workspace @wemux/web-client`：155/155，0 fail、0 skipped。
- `node --experimental-strip-types --test packages/web-client/tests/conversation-submission.integration.test.mjs`：1/1 通过。
- `npm run typecheck --workspace @wemux/web-client`：通过。
- `npm run typecheck --workspace @wemux/web-contract`：通过。
- `npm run typecheck --workspace @wemux/web-next`：通过。
- `git diff --check` 和独立新增文件 patch whitespace 检查：通过。

原始日志、index preimage、基线源文件 hash、最终文件 hash、incremental patch、初末 git status 和 provenance 位于 `/tmp/wemux-conversation-submission-1791054835`（本次 writer evidence 目录；以 handoff 内实际路径为准）。无 staging/commit/reset/clean/stash/push，无 install、root build/pack/deploy、live 凭据/数据库、8004 端口。Next/客户端既有脏树来源保留，构建产物不是交付源文件。

后续：先独立 review，再由 Next owner 按上述 API 接入 composer、错误和显式 retry UI；另行完成真实浏览器、移动端及获授权 Runtime 验收，不把本次 headless 证据升级为整票完成。

## Review P1/P2 有界修正（writer 已验证，待独立复审）

保留前轮 review 的 **BLOCK** 历史：P1 为确认状态写入失败后，同实例 `load/edit` 清掉已验证 admission，失败 retry 又把已知接收描述成未知；P2 为 persist-before-send/冻结断言放在故意抛错的 sender 内，被 controller catch 吞掉。该修正仅改 `conversation-submission.ts`、专用 unit test，并追加本文；不改 index、integration、其他共享 seam、UI、Server 或 Worker。

现在 in-memory admission 关联完整原意图（commandId/messageId/content/draftRevision）；同一未决意图的 load、草稿编辑、失败重试、重复 submit 保留 receipt 和“已收到消息接收回执，但无法保存确认状态”警告。flight 结果携带完整 intent，未加载的并发 joiner 也能保留同一回执。发布快照按当前精确 intent 选 receipt，不能将旧 receipt 粘到替换意图，即使下一意图的持久化失败；dispose 清除观察事实。持久化 intent.receipt 仍是 null，不凭内存 receipt 宣称 durable settlement、不允许 submit 换身份；成功 retry 持久化后才消除警告。原草稿 revision/ABA 保护保持不变。

API 签名无变化。`status: uncertain` 仍可表示 durable settlement 未完成，但 `admission !== null` 加中文 settlement warning 明确表示已有接收事实，而非接收未知。UI 不能把 status 单独翻译成未知接收，也不能将 command receipt 当 Turn 成功。内存事实不跨 dispose/整页刷新传播；若存储确认状态写入失败，全新实例仍只能从原持久身份显式安全重试，不伪造已保存事实。不同 scope/不同意图不继承 receipt。没有自动发送或管理员 receipt 依赖。

P2 的 sender 仅捕获发送时 raw storage、冻结状态、mutation error；所有相关断言移到测试体的 `await submit()` 之后。两个负控分别禁用冻结、在 dispatch 前移除持久 intent，在 owned `/tmp` 的生产模块副本与测试副本上执行，均 exit 1（外层断言检测到），repo 源码/测试/构建产物未注入负控。

新增 8 个 regression cases（unit 共 24）：load、edit、失败 retry、完整身份/正文/revision 隔离与 dispose、成功恢复后新意图、旧 flight 对替换意图、下一意图持久化失败不泄漏旧 receipt、未加载并发 joiner。

证据 `/tmp/wemux-submission-fixes-7t4zIF/`：

- 修正前真实 red：`node --experimental-strip-types --test packages/web-client/tests/conversation-submission.test.mjs` exit 1，22 项中 5 red；`regression-red.log` 与 `red-test.mjs` 保存，未覆盖旧轮 evidence。
- 补充 final regressions 对原 preimage 的 `/tmp` 副本执行：exit 1，24 项中 7 red；`preimage-regression/result.log`。
- `npm run build:packages` exit 0；focused unit 24/24 exit 0；`npm test --workspace @wemux/web-client` 163/163 exit 0、0 skip；既有 dedicated real-Server integration 1/1 exit 0。
- `npm run typecheck --workspace @wemux/web-client`、`@wemux/web-contract`、`@wemux/web-next` 均 exit 0。
- `unfrozen-final/result.log`、`not-persisted-final/result.log`：bounded negative controls 均 exit 1，符合预期；仅 `/tmp` 副本有 mutation。
- fresh 三文件 preimages、baseline/final hashes、incremental.patch、preservation.log、初末 status、diff/whitespace 与空 index 检查附在该目录。原 HEAD `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255` 不变；除三条获准路径外基线源文件不变。

此为 writer 绿测，不替代 reviewer gate。Ticket04/all16 仍 partial；无新增 UI/browser/mobile/visual/真实 Runtime 验收，visual model 不可用状态不变。未 install、未接触 live 凭据/数据库、未用 paid Runtime/8004、未 root build/pack/deploy、未作 git mutation。

## Loaded joiner 与可操作错误修正（writer 已验证，待独立复审）

保留上一轮 review **BLOCK**：原吞断言 P2 已解决；新增 P1 是 B 已加载上一条 durable settled intent 时，加入 A 的新 flight 会因旧 known 不匹配而丢失新 POST receipt；新增 P2 是 receipt retention 无条件覆盖 invalid/stale/save/storage 错误。本轮只改 submission 源码、专用 unit test 并追加本文。

flight 完成后先读取并核对当前持久意图，再把 validated outcome 关联到**将采用的精确 intent**，不再用 joiner 的旧 settled known 拒绝合法新 observation。若读取失败，仅能保留属于本实例原 known 的 receipt；原可操作读取错误不会被 flight 的 generic settlement outcome 覆盖。若读取采用的是不相关/被替换的正文、身份或 draftRevision，不附旧 receipt，明确 stale。原 submit/retry 准入条件不变，内存 receipt 不允许新建消息身份，不写成 durable intent.receipt。

已知 admission 继续显示，但 error 仅在为空、generic uncertainty 或 pending 时补为 settlement 说明；invalid/stale/save/storage 等具体错误保留。settlement 文案移除“原身份仍保留”这个在存储丢失时无法保证的断言，改为要求恢复存储并核对原请求。API 无扩展，status 仍不代表 Turn 成败，调用方须同时展示 admission 与具体 error。

七个新增确定性 regression：loaded settled joiner 的新 flight、后续 load/edit/失败 retry/无额外 mint；invalid edit、保存失败、读取拒绝、记录丢失、记录替换下的具体错误；loaded joiner 对 commandId/messageId/content/draftRevision 各种替换不继承 receipt。全部既有重入、身份、dispose 和外层 persist/freeze 断言继续通过。

新 evidence：`/tmp/wemux-submission-joiner-xUjtl1/`。修正前先写 tests，`red.log` exit 1：30 tests，24 pass、6 fail；原 source preimage 与最终测试复制到 owned `/tmp/preimage-regression` 后再次 red exit 1：31 tests，24 pass、7 fail。首次实现中对读取错误直接返回 blocked 导致两个既有 uncertain 状态断言失败，`green-1.log` 原样保留；已恢复原状态行为，同时保留具体错误，未放宽测试，最终无未解 red。

最终命令：`npm run build:packages` exit 0；focused unit 31/31 exit 0；`npm test --workspace @wemux/web-client` 170/170、0 skip、exit 0；未改的 dedicated real-Server integration 1/1 exit 0；web-client/web-contract/web-next typecheck 各 exit 0。`git diff --check`、逐文件 preimage-relative whitespace check 无诊断，index 空。fresh preimages、初末 status、baseline/final hashes、incremental.patch、preservation/provenance 和全部 red/green 日志随 evidence 保留，旧两轮 evidence 不修改。

Ticket04/all16 仍 partial，独立 reviewer gate 未完成；无 UI/browser/mobile/visual/真实 Runtime 新证据，visual unavailable 状态不变。内存 receipt 在 dispose/full reload 后仍无法恢复未写入存储的确认事实；原持久 intent 可显式重试。存储不是授权/加密/跨 tab exactly-once。不 install，不接触 live 凭据/数据库，不用 paid Runtime/8004，不 root build/pack/deploy，不作 git mutation。

## Next composer integration slice (partial, writer checked; independent review required)

The shared submission helper was accepted by parent after reviewer `a9dd84de` reported OK with notes and parent verified three hashes plus 31/31 focused tests. This integration **does not modify that helper, controller, projector, transport, contracts, Server, Worker or legacy product code**. Ticket04/all16 remain partial; sending admission is not a complete conversation execution delivery.

### Integration and lifecycle

`ConversationComposer` consumes the existing authenticated `ProjectClient`, full immutable submission scope and current read controller from `SessionConversation`. It constructs/subscribes/loads the existing `createConversationSubmission` only in a committed effect, obtains the same `window.sessionStorage` lazily, and disposes/unsubscribes on client/scope replacement or unmount. Render-time client-object/key checks hide prior snapshots before effect cleanup; live callbacks and a committed authority reference prevent a late dispatch/callback from crossing host/account/team/project/task/session lifetimes. No second submission state machine, command receipt polling or auto-send effect is added.

The new `conversationSendDenial` UI guard requires a current `ready` read snapshot, no `needsRefresh`/read or subscription error, an active `watching` subscription, exact read-scope and Session Project/Task/Session matches, `canRead && canWrite`, nondeleted/nonarchived Session and authoritative `sendCapability.allowed`. It checks on rendering, on explicit submit/retry and again inside the helper's injected send callback. The current metadata is not inferred from cached draft/receipt. Server POST authorization is a second boundary, not a substitute for the UI gate.

Capability basis: `packages/web-contract/src/action-capability.ts` `evaluateCapability('send', ...)` allows `offline` Workers for durable independent messages when a ready Workspace and available execution Agent/advertised Model remain valid. `apps/server/src/application/server-service.ts` `enqueueInTx` rechecks Session write access, Task/Workspace lifecycle and `sendCapability` before command deduplication. Accordingly, Journal offline freshness alone does not deny an explicitly allowed durable enqueue; stale/unavailable/error metadata and denied capability do. Desktop/mobile checks prove both offline+allowed and offline+denied cases. No guessed archive or lifecycle authority is supplied by storage.

The Chinese composer separates current draft from an expandable immutable original request with Command/Message IDs. Both new send and retry are explicit. Unresolved original identity prevents a new message even if a memory-only admission is known. Receipt status is described as Command admission/state, never Turn success or Task completion; the exact actionable helper error remains visible alongside known admission. Editing while unresolved preserves the new draft without replacing original body. Failed local draft persistence retains the unsaved text visibly with a warning and explicit save action; it cannot be submitted as a new message. Corrupt storage is not deleted, and a read-only reload action never sends.

Disclosure is explicit: same-tab sessionStorage supports saved-content refresh recovery only; closing the tab, clearing storage or browser data loss may destroy it. Leaving/closing does not retract submitted commands and never auto-retries. Local plaintext is not encryption/authorization/cross-tab exactly-once. Account changes hide prior account drafts/intent; full storage destruction cannot reconstruct an unknown identity. Stop, approvals and model mutation remain unavailable. Parent separately approved the **single outdated TaskSessions disclaimer replacement**; its create/retry logic is unchanged.

### Owned files and preservation

Fresh baseline HEAD remains `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`; the dirty/untracked tree, not HEAD alone, is the exact preimage.

- New `apps/web-next/src/components/ConversationComposer.tsx`.
- New `apps/web-next/src/lib/conversation-send-gate.ts`.
- New `apps/web-next/tests/conversation-send-gate.test.mjs`.
- New `apps/e2e/next-composer-browser.mjs`.
- Modified `apps/web-next/src/components/SessionConversation.tsx`: composer integration and no-longer-read-only labels.
- Modified `apps/web-next/src/components/TaskSessions.tsx`: only parent-approved outdated disclaimer.
- Modified `apps/web-next/src/styles.css`: composer-local styles.
- Modified `apps/e2e/next-conversation-browser.mjs`: only the renamed region/heading locators, original recovery/safety assertions retained.
- Appended this document and ignored `.scratch/web-next-project-agent-platform/issues/04-task-session-conversation.md` evidence note. Neither ticket status nor integrated checkbox is marked complete.

Evidence root `/tmp/wemux-next-composer-QeZE78/` contains fresh preimages (including ignored Ticket04), repository source hash baseline, exact incremental patch, final hashes, preservation output, build/script/screenshot provenance, empty index records, and complete logs/commands. Frozen UI build: `/tmp/wemux-next-composer-QeZE78/final-dist`. No shared files were edited. No staging/commit/reset/clean/stash/push, new dependencies, root build/pack/deploy, live data/credentials, paid model or port8004 usage.

### Browser validation and visual limitations

Original integration browser: **28 checks passed**, desktop1440×1000/mobile390×844, evidence `/tmp/wemux-next-composer-browser-bJsAjZ/`. It uses a real owned ephemeral Server, public auth and Task Session APIs, actual built Next/shared client, synthetic isolated Worker capability/Workspace fixtures and no Worker/Runtime execution. Lost responses are intercepted only **after actual browser `Response.json` body consumption**. In this original 28-check run, held late responses cross Session/account/team replacement. Its subsequent Task switch proves draft isolation only: the held response had already settled before that Task switch. Independent Task-switch late-response coverage was added in the test-only follow-up below; the original combined claim is corrected here. Assertions use consumed/settled signals and UI work barriers, not fixed sleeps. Team switching adopts the actual application client and shows the new team's exclusive Project before entering its Task. Account switching uses actual logout/login in the same tab.

Covered on both viewports: draft reload/no automatic POST, successful response lost then explicit original-body/IDs retry, single persisted enqueue command, duplicate submit, newer draft preserved during pending/settlement, known memory-only receipt with actionable storage/save errors and no new-send authority, denied read/write/corrupt storage, archive and capability-denied gates on original retry as well as new send, held stale metadata disables both buttons, offline allowed durable admission versus offline denied capability, Session/team/account held late receipt suppression and subsequent Task draft isolation (not Task late-settlement suppression in this original run), actual viewer read-only denial, no admin receipt GET, and no horizontal overflow. Commands remain pending in the synthetic fixture; no Turn execution is claimed.

The single-command oracle enumerates all owned Worker command summary IDs with a nontruncation assertion, reads each persisted detail, filters the exact Session's enqueues and asserts one command with original commandId/messageId/content. It does not confuse two POSTs with two executions or use one known-ID lookup alone to claim uniqueness. Evidence stores only required IDs and synthetic message bodies, not capability credentials.

Screenshots:

- `/tmp/wemux-next-composer-browser-bJsAjZ/desktop-pending.png`
- `/tmp/wemux-next-composer-browser-bJsAjZ/desktop-readonly.png`
- `/tmp/wemux-next-composer-browser-bJsAjZ/mobile-pending.png`
- `/tmp/wemux-next-composer-browser-bJsAjZ/mobile-readonly.png`

Visual acceptance remains **unverified**. Previously both writer image reading and parent `vision_analyze` were unavailable; no provider configuration/install/fallback was attempted. Browser geometry/accessibility assertions are not visual approval. Independent reviewer and eventual visual acceptance remain required.

### Historical failures and exact attribution

1. `/tmp/wemux-next-composer-browser-3c5RUv/` initially failed the command-count assertion (`0 !== 1`). The new test erroneously read `.command` on `CommandProjection` list summaries. Source inspection (`server-store-types.ts`, SQLite `commandReader`) proves list summaries contain ID/status/fingerprint, while `getPendingCommand` reads the persisted full row without a status filter. Parent approved the test-only enumeration/detail correction above. Red log and script preimage are retained.
2. `/tmp/wemux-next-composer-browser-MPwDo8/` failed waiting for exact `getByLabel('查看团队')` during team navigation. The initial run lacked a failure DOM snapshot, so **its original cause remains unclassified**. A later aria snapshot showed the combobox's name exactly `查看团队`, disproving the proposed dynamic-option-name explanation. Parent approved explicit heading/readiness, unique/visible/enabled assertions and exact `getByRole('combobox', {name:'查看团队', exact:true})`; final checks pass. This is a test synchronization/selector change, not a proven product accessibility fix or proof of the historical failure cause. New failures now capture DOM/aria automatically; do not infer the red passed retrospectively.

Intermediate passing runs `/tmp/wemux-next-composer-browser-lUmo9m/` (prefix role selector) and `/tmp/wemux-next-composer-browser-QooyhR/` (final exact selector) each passed26 checks; final adds stale/archived/denied retry assertions for28. Raw `*-original-command.json` files in `MPwDo8` and `lUmo9m` were subsequently redacted, with parent approval, to remove unnecessary full command capability payloads; only commandId/sessionId/message and synthetic POST evidence remain. Later runs record the sanitized shape directly. Other non-sensitive red evidence is preserved.

### Final commands/results

Explicit browser configuration throughout:

```sh
export PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs
export PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
export WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-composer-QeZE78/final-dist
npm run typecheck --workspace @wemux/web-next
npm run typecheck --workspace @wemux/web-client
node --experimental-strip-types --test apps/web-next/tests/conversation-send-gate.test.mjs
npm test --workspace @wemux/web-client
npm run test:prepared --workspace @wemux/web-next
node_modules/.bin/vite build --config apps/web-next/vite.config.ts --outDir "$WEMUX_NEXT_TEST_DIST"
node --import tsx apps/e2e/next-composer-browser.mjs
node --import tsx apps/e2e/next-conversation-browser.mjs
node --import tsx apps/e2e/next-task-session-browser.mjs
git diff --check
```

Final normal results: typechecks and private build exit0; focused new gate2/2; full client170/170; full Next141/141; composer28; retained recovery45 (`/tmp/wemux-next-conversation-browser-DBRclc/`); unchanged Task Session creation/retry29 (`/tmp/wemux-next-task-session-browser-lMftXc/`); zero skips. Next `test:prepared` runs the complete existing glob plus the new focused tests using existing prepared dependencies, not standalone pretest which would rebuild legacy repository dist. Prepared artifacts/source hashes are captured. Historical red commands exit1 and remain recorded separately. No whole-ticket or real Runtime acceptance is claimed.

Remaining: independent review, visual acceptance, actual authorized Runtime/browser execution lifecycle, dual-host Worker workbench, approval/stop/model control. Current UI freshness is the read controller's observed validity; this does not introduce instantaneous authorization revocation or cross-tab durable CAS. Shared helper residual risks and inherited full-history retention limits remain unchanged.

## Review P2 follow-up: independent Task-switch late response (test/evidence only)

The independent composer review was **OK with notes**, with a valid P2 attribution finding: the original held response settled after a same-Task Session switch and **before** the subsequent Task switch. That original scenario proved Session late-settlement suppression and Task draft isolation, not independently exercised Task late-settlement suppression. The old check label and original coverage wording above are corrected without rewriting the recorded 28-check result. No production defect was demonstrated or repaired.

This follow-up owns only `apps/e2e/next-composer-browser.mjs`, this document and an ignored Ticket04 evidence append. Product source, shared helpers, contracts, other browser scripts, build artifacts and earlier evidence remain unchanged. Fresh preimages, baseline/source hashes and initially empty incremental patch were recorded before edits under `/tmp/wemux-task-switch-late-bqZd5K/`; the finalized patch/hashes describe only this three-path increment.

### Independent causal ordering, both viewports

The new scenario performs an additional explicit submission and uses the existing actual browser `Response.json` hook to consume a successful **HTTP202** body, checking its Session path and exact commandId/messageId against the persisted original intent. It holds the response unresolved, then uses actual Task and Session list controls to select a different Task and its Session. Before releasing, it checks URL Task/Session identity, panel Session identity, a ready destination composer and independently persisted destination draft with no intent/error. Source receipt remains unresolved.

Only after that destination state is established does it release the original response. It waits for the actual settlement counter and two rendering frames plus a MessageChannel task. A destination MutationObserver detects any rendered original text/IDs, receipt or error while the release is processed. Post-barrier assertions require identical destination composer text and stored draft/state, no original request region/receipt/error, no observed leak, unchanged source durable intent with null receipt, and no extra POST. The scenario then returns to the source and explicitly retries only to reconcile its original identity before continuing existing team/account checks.

The original Session scenario remains, with its label narrowed to Session late-response suppression followed by Task draft isolation. Existing team/account replacement checks, exact team role/name selector and readiness assertions, persistent unique-command enumeration, failure DOM/aria capture and capability/credential redaction are retained.

### Run and provenance

HEAD: `93c9f67cab09ca51bd95d8bdb14d7d0ca99f0255`. Before running, all **44 product-source hashes and 4 frozen dist hashes** were recomputed against `/tmp/wemux-next-composer-QeZE78/provenance.json`. All matched. The test reused `/tmp/wemux-next-composer-QeZE78/final-dist`; no rebuild, deployment or product edit occurred.

All commands exit0:

```sh
node --check apps/e2e/next-composer-browser.mjs
PLAYWRIGHT_CORE_PATH=/tmp/wemux-tailnet-pw/node_modules/playwright-core/index.mjs \
PLAYWRIGHT_CHROMIUM_PATH=/opt/data/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
WEMUX_NEXT_TEST_DIST=/tmp/wemux-next-composer-QeZE78/final-dist \
  node --import tsx apps/e2e/next-composer-browser.mjs
git diff --check
```

Full updated composer browser: **30 checks**, desktop1440×1000 and mobile390×844, zero observed page errors and zero admin receipt reads, first run green. Evidence `/tmp/wemux-next-composer-browser-A9Ez3O/`. No blind retries or negative-control/product-mutation claims. Prior red logs remain at their original paths; the historical team-selector timeout remains unclassified, not attributed to a cause lacking contemporaneous evidence. Other suites were not rerun because only this browser test/evidence changed; previous suites remain historical results, not newly executed gates.

`desktop-task-late-response.json` and `mobile-task-late-response.json` both record:

- Before sending: consumed7 / settled7.
- Successful response consumed and destination Task/composer/draft ready **before release**: consumed8 / settled7.
- After release and UI barrier: consumed8 / settled8; leaks `[]`.
- Destination UI/storage unchanged; original durable receipt unresolved; zero extra POSTs.

New screenshots: `/tmp/wemux-next-composer-browser-A9Ez3O/desktop-task-late-response.png` and `/tmp/wemux-next-composer-browser-A9Ez3O/mobile-task-late-response.png`. Existing pending/read-only screenshots were also captured by the unchanged full suite. Visual acceptance remains **unverified**; screenshots and DOM assertions are not visual signoff. The final `cleanup.json` records owned browser/Server closed and application/transport SQLite removed.

Evidence root `/tmp/wemux-task-switch-late-bqZd5K/` contains `preimages/`, `repository-before.json`, `hashes-before.json`, `hashes-before-after.json`, `incremental.patch`, before/after source/dist verification, preservation, script/screenshot provenance, syntax/browser/diff logs, exact command records, reproduction script and empty index records. Real application/public HTTP behavior is retained with an owned synthetic Worker capability fixture, not real Worker/Runtime execution. No credentials/capability payloads are added to the new evidence.

Reviewer checklist: inspect preimage-relative three-path patch; verify HTTP202 receipt IDs; verify different destination Task before release (8/7 counters); verify post-settlement UI/storage/no-leak assertions (8/8); verify original Session/team/account safety checks remain; recompute source/dist preservation and empty index. Independent review remains required for this follow-up. Ticket04/all16, real Runtime, dual-host and visual gates remain partial/unverified, with no signoff promotion.
