# 03: 资源管理面写路径（资源 / 修订 / 绑定 / 预设）

Status: ready-for-agent
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

- [ ] 六类资源可在管理面内完成建/改/删与修订发布（技能含 blob 上传与 sha256 去重；Provider 含 `expectedVersion` CAS）
- [ ] 绑定创建/撤销与预设创建/应用可在管理面内完成，并以 `requestId` / `expectedRevision` / `expectedSetRevision` 幂等与乐观并发
- [ ] 冲突与校验失败给出明确原因，不静默失败；写后投影重新核验且不闪空态
- [ ] 非管理员无任何写入口；Server 侧授权仍是唯一判定
- [ ] 真浏览器覆盖桌面与移动；证据按仓库惯例留存，脱敏摘要入库

## Prior art 与依据

- 既有授权 API 与错误映射：`apps/server/src/http/routes/node-resource-routes.ts`（全文件；`presetError` 冲突/校验集合；Provider 字段白名单）。
- 旧前端写路径基准：`apps/web/src/features/skills/skill-studio.tsx`（技能 blob→修订→绑定→撤销）、`apps/web/src/features/presets/preset-studio.tsx`（Provider 创建/发布、预设应用）、`apps/web/src/api/client.ts` 写方法。
- 新只读面与待扩展点：`apps/web-next/src/components/ResourceManagement.tsx`、`packages/web-client/src/resource-management.ts`（注释明确「不提供旁路写路径」，本票在授权 API 之上补动作，不违背该约束）。
- 领域语义：`CONTEXT.md`（资源修订不可变、绑定撤销为 `pending-gc`、预设应用幂等）。
