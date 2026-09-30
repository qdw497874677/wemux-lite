# 待办查询真实存储回归

## 修复

- `SqliteAttentionSource` 原来假设 tasks 有 title/status/assignee_user_ids_json/updated_at 列、运行存于 runs 表；真实迁移使用 tasks.data JSON 与 task_runs。空数据库也会 SQL 500。改为 JSON 字段投影、task_runs 与 tasks/commands 关联查询，无数据库迁移或数据重建。
- Task.assignee 是 Worker/Agent 指派，不是人员指派；当前领域没有人员指派字段，不能据 owner 或任意 JSON 字段生成“指派给我”。此来源返回空人员集合，该分组暂无事项。Run 的失败项按 enqueue command 的 sentByAccountId 归属；历史缺失提交者不猜测为 Session owner。当前 Run 状态没有 blocked，筛选真实 failed 状态。
- 修复 SQL 后实机发现第二个错误：AttentionService 请求审批 limit=200，但 ProjectionService 上限为100。现按100逐页读取，避免400和截断后续审批。

## 验证

真实数据库迁移的空库/有数据测试、失败 Run 提交者与 Session owner 区分、旧记录无提交者、审批分页测试；真实 HTTP 组合（管理员 PAT、普通用户 Cookie、未登录401）共7项定向通过。原SQL回归修复前稳定报 `no such column: title`，分页回归修复前稳定拒绝 limit>100。

完整 npm test：Node875/867 pass/8 skipped/0 fail，packages10 pass，Web293 pass（`/tmp/attention-final-tests.log`）；typecheck和Server build通过（`/tmp/attention-final-typecheck.log`、`/tmp/attention-final-build.log`）。最后仅调整测试 Headers 的类型构造。

已部署本机固定实例8010，新账号真实Chromium GET `/api/attention` 200、`/attention` 展示空态且无加载失败；原Worker同身份online复验通过。截图 `/tmp/wemux-attention-fixed.png`；数据、账号、授权未改。长期回归脚本为 `apps/server/src/test/attention-http.test.ts`、`attention-source.test.ts` 和 `attention-service.test.ts`，临时浏览器脚本不含硬编码凭据。
