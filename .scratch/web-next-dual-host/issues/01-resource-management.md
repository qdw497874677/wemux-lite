# 01: Worker / Agent / Model / Skill / Preset / Provider 管理面

Status: ready-for-agent
Blocked by: 无未完成 ticket 前置；复用现有 Project/Workspace、Worker 与授权基线，不依赖画布、连接器或计划交接验收。

**Spec:** [资源管理与独立 Worker 双宿主](../spec.md)
**合并来源:** `43966aa` 的原票 01（范围不变）。
**What to build:** 管理员在一个管理面管理 Worker、Agent 能力、Model、Skill、Preset、Provider，四态（已配置、已认证、已分发、可执行）分离展示，版本与能力来自运行时真实探测。

## 实现计划

1. 盘点 Worker discovery、runtimes/management 与 ResourceReconciler，资源版本及认证/可执行状态只从真实探测投影。
2. Server 授权管理 API 与 web-next 管理面共用状态；远程托管安装需显式确认，固定版本、独立目录，不作为 Worker 启动依赖。
3. 测未安装/未认证/离线、安装失败与撤权、Secret 脱敏；真实浏览器覆盖四态及失败恢复。执行容量合同归[派发 spec](../../web-next-task-dispatch/spec.md)，不混用分发并发上限。

## 验收

- [ ] 六类资源均可列出、查看与配置
- [ ] 四态分离展示，配置状态不冒充可执行状态
- [ ] 版本与能力来自真实探测，探测失败如实上报不可用
- [ ] 远程安装 Agent 不覆盖全局安装，失败给出明确原因
- [ ] 无权限用户不能修改管理面配置
- [ ] 断言与截图作为证据留存
