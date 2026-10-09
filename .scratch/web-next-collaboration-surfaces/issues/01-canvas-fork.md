# 01: 画布共享与 Fork 血缘

Status: ready-for-agent
Blocked by: 无未完成 ticket 前置；复用现有账号授权与 Task Session 基线，不依赖计划交接或跨 Runtime 闭环验收。

**Spec:** [会话协作界面](../spec.md)
**合并来源:** `43966aa` 的原票 01（范围不变）。
**What to build:** 会话画布按权限共享与访问；用户可在同 Task 下从固定 cursor Fork 出新会话，保留血缘；撤权后列表、血缘、缓存与实时流同步过滤，清理受控客户端缓存并阻断后续访问；已下载副本不能回收。

## 实现计划

1. 盘点 Session 关系、cursor 和权限投影，在 `apps/server/src/application` 的关系查询中统一过滤列表、标题、计数与血缘。
2. 实现同 Task 固定 cursor Fork 及 web-next 画布入口，明确共享 Placement 文件不因私有 Session 隔离。
3. 两用户真实浏览器验证撤权后四出口过滤与断流、刷新和重连，保留原会话历史及证据。

## 验收

- [ ] 画布内容只对获权成员可见，未获权访问被拒
- [ ] 同 Task 下 Fork 固定 cursor，血缘可追溯
- [ ] 撤权后列表、血缘、受控客户端缓存与实时流四个出口停止提供并清理；不承诺回收已下载副本
- [ ] Fork 不修改原会话历史
- [ ] 断言与截图作为证据留存
