# 03: 资源管理面写路径（资源 / 修订 / 绑定 / 预设）

Status: ready-for-human
Blocked by: 无（复用既有受审计 API 与授权基线）；与 04 共用 web-client 写操作约定。

**Spec:** [资源管理与独立 Worker 双宿主](../spec.md)
**来源:** 自票 01 移交（票 01 验收第 1 项：管理面内的配置动作）。票 01 的四态只读投影已完成，本票补齐写路径。

**What to build:** 管理员在 `/next/resources` 管理面内完成全部资源写操作，不需要回到旧前端或手工调用 API：

1. 资源建/改/删（`POST/PATCH/DELETE /api/resources*`）。
2. 技能修订发布：上传 blob（`PUT /api/resource-blobs/:sha256`，按 sha256 去重）+ 发布修订（`POST /api/resources/:resourceId/revisions`）。
3. Provider 修订发布：`POST /api/resources/:resourceId/provider-revisions`，携带 `expectedVersion` 乐观并发；首个 Provider 修订（latest=0）走通用 `POST /revisions`。
4. 绑定创建与撤销：`POST /api/resource-bindings`（`UNIQUE(worker_id, resource_revision_id)`，同 Worker 上同技能旧绑定必须先撤销）、`PATCH /api/resource-bindings/:bindingId`（`expectedRevision` CAS，撤销为 `pending-gc`，不物理删除）。
5. 预设创建与应用：`POST /api/resource-presets`（`expectedRevision` CAS）、`POST /api/resource-presets/:presetId/applications`（必带 `requestId` 幂等 + `expectedSetRevision` CAS）。

写操作仍走既有授权 API，不新增旁路、不改 Server 授权判定；非管理员在管理面零写入口。

## 实现计划

1. `packages/web-client` 增加资源管理写操作（typed），沿用现有错误语义：409 冲突 → 提示刷新重试（`preset_revision_conflict`/`preset_application_request_conflict`/`resource_set_revision_conflict`/`preset_binding_conflict`/`provider_version_conflict`），400 校验失败 → 显示具体原因（`invalid_provider_config`、`invalid_provider_revision` 等）。
2. `/next/resources` 六个分区加入管理动作：新建/编辑/删除资源、发布技能修订（含 blob）、发布 Provider 修订（CAS）、创建/撤销绑定、创建/应用预设。表单校验、冲突处理、写后重新核验四态投影（复用现有「重新核验期间保留已确认投影」行为，不把刷新显示成没有资源）。
3. 复制/粘贴类交互在不安全上下文用现有 `copyText()` 降级（`src/lib/utils.ts`），不得直接用 `navigator.clipboard`。
4. 测试：web-client 契约测试；`apps/web-next` 组件测试；真浏览器 e2e 覆盖桌面 1440×900 与移动 390×844：管理员完成建资源→发修订→绑定→撤销→预设应用；非管理员零写入口、零请求；409 冲突后刷新重试；`requestId` 重放不产生重复资源/绑定。

## 验收

- [x] 六类资源可在管理面内完成建/改/删与修订发布（技能含 blob 上传与 sha256 去重；Provider 含 `expectedVersion` CAS）（四类可写资源——技能、Agent 运行时、模型 Provider、连接器配置——已逐类验证建/删；Worker/Agent/Model 三类由 Worker 真实探测上报，管理面按设计只读，无对应创建 API）
- [x] 绑定创建/撤销与预设创建/应用可在管理面内完成，并以 `requestId` / `expectedRevision` / `expectedSetRevision` 幂等与乐观并发
- [x] 冲突与校验失败给出明确原因，不静默失败；写后投影重新核验且不闪空态
- [x] 非管理员无任何写入口；Server 侧授权仍是唯一判定
- [x] 真浏览器覆盖桌面与移动；证据按仓库惯例留存，脱敏摘要入库

## 验收记录（2026-10-14，分支 `dualhost-03-resource-write`，基点 `74c9c9c`，已 merge `main`@`74c9c9c`）

实现提交（中文提交，功能与验收脚本分开）：

| 提交 | 内容 |
| --- | --- |
| `24b0554` | web-contract `./resource-write` 传输契约 + web-client `resourceManagementOperations` 增补写操作与 409/400 语义判定 + web-next「管理动作」写面板 + 真浏览器验收脚本 |
| `5881b3e` | 验收脚本覆盖 Agent 运行时与连接器配置的建与删（四类可写资源的建/删闭环） |

验证命令与退出码（日志均在 `/var/tmp/wemux-d03-*.log`）：

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| `npm run build:packages` | 0 | `wemux-d03-build-packages-2.log` |
| `npm run typecheck`（全 workspace） | 0 | `wemux-d03-typecheck-6.log` |
| `npm run build --workspace @wemux/web-next` | 0 | `wemux-d03-webnext-build-5.log` |
| `npm test --workspace @wemux/web-client`（327 用例） | 0 | `wemux-d03-webclient-test-2.log` |
| web-next 全量（`tests/*.test.mjs` + `src/components/__tests__/*.test.mjs`，195 用例，含真 Chromium） | 0 | `wemux-d03-webnext-test-7.log` |
| `node --import tsx apps/e2e/next-resource-management-write-browser.mjs`（20 项断言，双视口） | 0 | `wemux-d03-e2e-write-14.log` |

真浏览器写路径验收（`apps/e2e/next-resource-management-write-browser.mjs`，可重复脚本已入库；真 Server 服务真 web-next dist、真 Worker CLI 上线并真物化、真 Chromium）：

- 桌面 1440×900 与移动 390×844 各跑一轮完整链路：新建技能资源 → 改描述 → 删临时资源（删除后 404）→ Agent 运行时/连接器配置各建各删 → 发布技能修订 v1（blob 去重 200 `deduplicated`）→ 绑定真节点 → 真 Worker 物化 `installed` 且投影显示 `已分发｜` → 预设创建（`expectedRevision` 0→1）→ 应用遇真 409 `preset_binding_conflict` 并提示刷新重试 → 同一意图重试复用同一 `requestId` → 撤销绑定转 `pending-gc`（行仍在，非物理删除）→ 发布技能 v2 → 预设载入编辑器改条目保存为 revision 2（`expectedRevision` CAS）→ 应用成功（`requestId` 重放返回同一 application、绑定数不变）→ 过期 `expectedSetRevision` 得 409 `resource_set_revision_conflict` → Provider 首个修订走通用 `POST /revisions`、第二个走 `provider-revisions`（`expectedVersion` 1→2），过期 `expectedVersion` 得 409 `provider_version_conflict`。
- 写后不闪空态：写操作前注入 MutationObserver 记录 `[data-axis]` 最小值，桌面 396、移动 412，均 > 0，证明重新核验期间保留已确认投影，从未闪回空态；六类只读分区与四轴数量写后仍完整。
- 非管理员：`/api/resource-inventory` 403 `admin_required`；页面零按钮、零状态轴、零资源接口请求（route 拦截计数为 0）、不出现节点名；带 CSRF 的直连 `POST /api/resources` 也被 403 `admin_required`，资源未创建——授权只由 Server 判定，界面不做权限推断。
- 脱敏证据：`/var/tmp/wemux-next-resource-write-IG86I5/`（`checks.json` + `desktop-administrator-writes.png`、`mobile-administrator-writes.png`、`member-denied.png`）。

已实现 / 已验证 / 部分完成：

- 已实现且已验证：四类可写资源（技能、Agent 运行时、模型 Provider、连接器配置）的建/改/删；技能 blob 上传 + sha256 去重 + 修订发布；Provider 首个/后续修订与 `expectedVersion` CAS；绑定创建与撤销（`pending-gc`）；预设创建（`expectedRevision` CAS）与应用（`requestId` 幂等 + `expectedSetRevision` CAS）；409/400 具体原因展示；写后重新核验且不闪空态；非管理员零写入口零请求。
- 部分完成（留给人工或后续票，不在本票验收）：Worker/Agent/Model 三类来自 Worker 真实探测，管理面只读（其「配置动作」在本票范围外）；技能 blob 内容只支持 SKILL.md 单文件（旧前端同约束），多文件/可执行文件资源包未做；预设条目暂不支持项目级 `projectId`（界面不传，服务端存 null）；冲突后不自动重试，按文案要求用户刷新后手动重试。

后续会话须知（本票踩到的坑）：

1. `GET /resource-preset-applications` 返回 `{ items: [{ application, items }] }`（包装结构），不是裸 application。
2. `presets()` 返回**每个修订一行**（`(id, revision)`），界面必须按 id 取最大修订去重，否则同一预设重复出现。
3. `resource_bindings` 有 `UNIQUE(worker_id, resource_revision_id)`：撤销只把行改成 `pending-gc`，行仍在，因此同一 Worker 上重新应用含同一修订的预设会 500；换新修订才能重新绑定。
4. Playwright 读响应体不可靠（`Network.getResponseBody` 偶发无数据）→ 断言只看状态码与请求体，冲突码用直连请求取回。
5. Chromium 会把预期的 4xx 记成控制台错误，控制台断言必须过滤 `Failed to load resource`。
6. 页面加载会调 `/api/auth/me` 轮换 CSRF，非管理员直连写断言必须先重新取当前 CSRF 明文，否则只能断言 `csrf_rejected` 而不是 `admin_required`。

## Prior art 与依据

- 既有授权 API 与错误映射：`apps/server/src/http/routes/node-resource-routes.ts`（全文件；`presetError` 冲突/校验集合；Provider 字段白名单）。
- 旧前端写路径基准：`apps/web/src/features/skills/skill-studio.tsx`（技能 blob→修订→绑定→撤销）、`apps/web/src/features/presets/preset-studio.tsx`（Provider 创建/发布、预设应用）、`apps/web/src/api/client.ts` 写方法。
- 新只读面与待扩展点：`apps/web-next/src/components/ResourceManagement.tsx`、`packages/web-client/src/resource-management.ts`（注释明确「不提供旁路写路径」，本票在授权 API 之上补动作，不违背该约束）。
- 领域语义：`CONTEXT.md`（资源修订不可变、绑定撤销为 `pending-gc`、预设应用幂等）。
