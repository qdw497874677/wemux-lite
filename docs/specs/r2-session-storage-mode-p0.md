# R2 会话存储模式 P0 验收

## 本次交付边界

- `SessionStorageMode = local | replicated | central` 是显式领域合同。当前仅 `local` 可执行；Server 创建接口明确拒绝其余模式（`409 storage_mode_unavailable`），Worker 对旧/未知命令也拒绝，避免把尚无镜像与 checkpoint 的模式误当作已经交付。
- 集群 Session 创建时持久化 `local`，通过 `session.create` 下发；Worker 本地独立工作台固定创建 `local`。旧 Server/Worker JSON 缺失模式时只在读取投影中解释为 `local`，不隐式改写历史行。旧创建请求与显式 `local` 使用同一幂等指纹。
- Fork 从来源继承模式（旧来源按 `local`），Run 复用沿用既有 Session 事实；不存在自动迁移。Web 会话详情显示「节点本地」并明确 Server 事件投影不构成完整会话恢复保证。
- `replicated`/`central` 的 mirror、加密、checkpoint、迁移 CAS、跨 Worker 恢复与独立 Worker Web/API 都不在本切片内，须按 `docs/design/session-storage-strategy.md` 后续分期单独验收。

## 可复查验证

```bash
npm run build:packages
npm run typecheck
npm test
npm run build --workspace @wemux/web
node apps/e2e/session-storage-browser.mjs
```

- 2026-09-29 独立复跑：`npm test` TypeScript 816 项（811 通过、5 跳过、0 失败）、包 9/9、Web 280/280；`npm run typecheck` 通过；浏览器验收通过。Fork 继承旧模式、Worker 拒绝命令并持久化 rejected receipt 均有专项断言；`git diff --check` 无输出。
- 浏览器脚本启动真实 Server 并加载生产构建 Web；仅鉴权/资源 API 使用缺失 `storageMode` 的旧 Session fixture，点击会话右侧面板，断言「节点本地」与事件投影免责文案及无页面异常。实际 Server/Worker 行为由上述集成测试验证，脚本并不冒充真实 Worker/模型验收。
- 原始截图与脱敏结果：`.scratch/r2-storage-mode/session-storage-local.png`、`.scratch/r2-storage-mode/browser-result.json`（不提交）。环境中测试使用 `PLAYWRIGHT_CORE_PATH` / `PLAYWRIGHT_CHROMIUM_PATH` 可覆盖现有沙箱路径。
