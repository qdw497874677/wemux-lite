# 02: 独立 Worker 本地宿主

**What to build:** Worker 无需 Server 即可提供本地鉴权 Web/API，用户可登录、创建与管理本地 Task、创建 Session 并对话、查看与下载本地结果；本地数据存于独立本地库，使用与集群相同的领域语义。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 未配置集群时本地 Web/API 可用，本地鉴权生效
- [ ] 本地 Task、Session、结果可完整创建、查看、下载
- [ ] 本地库独立，不与集群数据混淆
- [ ] 领域语义与集群一致（Task/Session/Workspace/Agent 术语不漂移）
- [ ] 宿主差异在界面与文档中明示
- [ ] 断言与截图作为证据留存
