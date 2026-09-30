# R3 按 Project/Worker 授权的模型候选（局部）

`GET /api/workers/:workerId/projects/:projectId/provider-candidates?agentKey=pi` 需已登录且同时有 Project 查看和 Worker 使用权。由 Server 已发布非秘密 desired set 计算适用绑定，project/agent 精确范围优先；冲突的最高优先级候选不返回。响应只包含 `{modelId,resourceId,bindingId,status:'not-verified'}`，不含 endpoint、变量名、credentialRef、Secret、原始资源或 Worker capabilities。撤销绑定后不再展示；不得将候选当作可运行模型。

后续必须有 Worker 自己对选定 Provider 的密钥与隔离 Pi 模型执行实际探测，然后带生命周期/权限失效语义报告 `ready`；在那之前 Server Session 创建与 Web 快速对话仍**不会选用候选**，不能伪装成模型可用。这条接口只是安全的发现入口，完整 Web 选择和 Session 写入验收尚未完成。

定向 `apps/server/src/test/resource-http.test.ts`、`resource-preset.test.ts` 10/10 pass（`/tmp/provider-candidate-route-test.log`），`npm run typecheck` 通过（`/tmp/provider-candidates-typecheck-final.log`）；完整 `npm test` Node 867 tests / 859 pass / 0 fail / 8 skipped、package 10 pass、Web 291 pass（`/tmp/provider-candidates-full-test.log`）。
