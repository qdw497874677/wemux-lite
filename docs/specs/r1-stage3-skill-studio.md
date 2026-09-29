# R1 阶段 3：Skill Studio 验收摘要

范围：项目导航中的技能工作室，面向实例管理员创建静态 `SKILL.md` 资源、发布不可变 revision、选择 Worker 和 Agent 范围建立绑定、查看 `{ binding, reconcile }` 投影并撤销绑定。当前资源 HTTP API 仅限实例管理员；普通项目成员看到明确的权限说明，而不是可操作的假界面。

实现边界：浏览器计算文件 SHA-256 和 manifest SHA-256，上传内容寻址 blob，再发布 revision；使用 `randomId()` 兼容 HTTP 非安全上下文。单个 `SKILL.md` 上限 1 MiB；服务端 blob 路由允许该大小经过 base64/JSON 编码后的请求体。写请求由已有 API client 携带 Cookie + CSRF；资源和 revision 的 `createdBy` 由 Server 根据已认证管理员重写，不信任浏览器字段。绑定状态每 5 秒刷新，不能把传输 ACK 误当安装完成。项目标识用于绑定和当前项目筛选。

验收（本阶段交付前独立执行）：

- `npm run typecheck`：通过。
- `npm test --workspace @wemux/server`：431/431 通过（含创建者归属测试）。
- `npm test --workspace @wemux/web`：280/280 通过（含路由断言和 UTF-8 hash 测试）。
- `npm test`：807 项 TypeScript 测试中 802 通过、5 项跳过、0 失败；9 项包测试通过；280 项 Web 测试通过。
- `npm run build --workspace @wemux/server` 与 `npm run build --workspace @wemux/web`：通过。Vite 提示主 chunk 大于 500 kB，属于现有构建提醒，不作为容量承诺。
- `node apps/e2e/skill-studio-browser.mjs`：真实 Server 静态服务与真实 Chromium 加载生产 Web，隔离拦截资源 API；验证发布顺序、UTF-8 blob、CSRF、项目绑定、轮询 ready、CAS 撤销、发布第二版、非管理员权限说明。该脚本**不等同**真实 Worker 分发验收。
- `node --import tsx --test apps/e2e/resource-reconcile.test.ts`：真 Server + 真 Worker 进程首次收敛、断线追赶及 ready 状态通过。该脚本不经过浏览器；两条链路分别覆盖 UI 与运行时。

原始浏览器截图、结果和临时数据库存于未追踪的 `.scratch/r1-stage3/`，不提交。后续 R1 阶段 4 仍需两 Worker 分发、Invocation 固定 revision、失败 hash、撤权不注入及 LRU 等独立 E2E；本阶段不声称这些已经完成。
