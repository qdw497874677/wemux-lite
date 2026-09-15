# Wemux Lite Web MVP

所有实现限于 `apps/web`，不依赖 shared package 的编译输出。UI 使用真实 HTTP 数据；连接失败、鉴权失败和契约不匹配均明确报错，不使用 mock fallback。

## 运行

```sh
npm run dev --prefix apps/web
npm run typecheck --prefix apps/web
npm run build --prefix apps/web
npm run test --prefix apps/web
```

测试使用 Node 原生 TypeScript strip（Node 22.18+，当前验证环境 Node 26）。不增加依赖。

打开 Web 的「Bootstrap / Token」：填写后端配置的管理员 Bootstrap Token，点击「Bootstrap 并连接」。后端初始化默认用户、Team、Project；已有环境可直接应用 Token。配置仅保存在当前页内存，不写入 localStorage，不保存 Agent/Git 凭证。

创建路径：Project → 新建 Workspace（填写 Git URL / revision，后端同时创建 Repository）→ 等待 Worker 报告 ready → 选择 Worker、Workspace、可执行且 available 的 Agent、Model → 创建 Session。支持 Agent 报告模型和自定义 Model ID，不硬编码模型。当前后端是单管理员 MVP，不能宣称已支持完整多用户 ACL。

## 集中契约 / 并行实现适配

- `src/api/dto.ts`：Web DTO、当前 Server resource DTO、命令与 Journal payload。
- `src/api/client.ts`：路由、fetch 鉴权/超时/错误、Server resource → UI summary 适配、EventSource 生命周期。
- `src/api/journal.ts`：按 `sessionId + seq` 去重排序、缺口检查、用户 queued/started/cancelled、assistant delta/终态、工具与失败状态。
- `src/api/use-session.ts`：按 Session 隔离历史、AbortController 清理、分页补拉、SSE 通知后读取持久 events、每 5 秒核对。

当前对齐仓库中并行实现的 Server HTTP handler（后端路由无 `/api` 前缀）：

| Web 请求 | 响应 / 请求约定 |
| --- | --- |
| POST `/api/bootstrap` | `{ user, team, project }`；使用已有管理员 Token，不签发 Token |
| GET `/api/workers`, `/api/projects`, `/api/workspaces`, `/api/sessions` | `{ items: [...] }`；Web 按 projectId 过滤 |
| POST `/api/projects` | `{ name, teamId, shareScope }` → Project；当前 Server 固定默认 Team / owner-only |
| POST `/api/workspaces` | `{ projectId, workerId, name, repository: { name, gitUrl, revision } }` → `{ workspace, commandId }` |
| POST `/api/sessions` | `{ workspaceId, title, agentKey, modelId, shareScope }` → `{ session, commandId }`；当前 Server 固定 owner-only |
| GET `/api/sessions/:id` | Session resource（含 binding） |
| POST `/api/sessions/:id/messages` | `{ commandId, messageId, content }` → `{ commandId, messageId, status }` |
| GET `/api/sessions/:id/events?fromSeq=1&limit=500` | `{ events, nextSeq, freshness }`；fromSeq 为 inclusive |
| GET `/api/sessions/:id/stream?fromSeq=1` | SSE `session.event`、`freshness`；原生自动重连 |

SSE 是失效通知；文字只从持久 events 投影，避免 replay/delta 重复拼接。先拉历史再订阅的间隙由 SSE 从同一游标回放及 onopen 补拉覆盖。所有分页读完才提交新历史。切换 Session、项目、Token 或卸载时取消请求并关闭旧流。无 freshness 不能显示已同步。HTTP 可用而 SSE 断开时保留 5 秒补拉，并明确提示实时流不可用。

当前 Server 不返回 `SessionSummaryView`。`toSummary` 明确适配单管理员 resource：freshness 初始 unknown，选中会话的队列数从 Journal 投影、freshness 来自 events API；未选中会话的队列数尚未核对。未来完整 ACL/summary API 应替换该适配，不得沿用单管理员权限假设。

发送期间仅锁住正在进行的 HTTP 请求，不因 Session running 禁用输入。下一条消息由后端持久队列处理；accepted/pending 仅显示收据，只有 Journal 才形成聊天事实。结果不明确时保留正文与同一 commandId/messageId 供重试，防止重复入队；切换会话/刷新会丢失未确认草稿，不自动重发。

## 代理与安全

`vite.config.ts` 将 `/api` 代理到 `http://127.0.0.1:3001` 并去掉 `/api` 前缀。fetch 使用 Bearer Header。原生 EventSource 不能设置 Header，因此开发代理将 **仅 SSE 路径** 的 `token` 查询参数转换成 Bearer，并在转发前删除 Token 参数（有真实代理集成测试）。

生产静态构建不包含 Vite proxy：部署者必须提供同等反向代理、HTTPS、禁止记录 SSE 查询凭证，或适配 HttpOnly Cookie / 短期 SSE ticket。不要直接将此开发 Token 桥暴露为公共生产认证方案。当前 Server 不支持 Cookie 时，空 Token 会得到明确 401。

## 验证边界

自动测试覆盖 Journal 去重/排序/gap/跨会话拒绝、运行中 queued、完成状态、HTTP 鉴权和错误、DTO 分页适配、EventSource 监听/关闭、Vite 路径重写和 Token 转发。代理测试使用隔离本地 HTTP fixture，不是 UI fallback。

尚需在实际 Server + 已注册 Worker + 可执行 Agent 上完成端到端验收；typecheck/build 与 fixture 测试不代表真实 Agent 已运行。MVP 不实现管理删除、停止 Turn、附件与完整权限管理，不保留原型中的模拟操作。
