# 01: Worker / Agent / Model / Skill / Preset / Provider 管理面

Status: ready-for-agent
Blocked by: 无未完成 ticket 前置；复用现有 Project/Workspace、Worker 与授权基线，不依赖画布、连接器或计划交接验收。

**Spec:** [资源管理与独立 Worker 双宿主](../spec.md)
**合并来源:** `43966aa` 的原票 01（范围不变）。
**What to build:** 管理员在一个管理面管理 Worker、Agent 能力、Model、Skill、Preset、Provider，四态（已配置、已认证、已分发、可执行）分离展示，版本与能力来自运行时真实探测。

## 验收

- [ ] 六类资源均可列出、查看与配置
- [ ] 四态分离展示，配置状态不冒充可执行状态
- [ ] 版本与能力来自真实探测，探测失败如实上报不可用
- [ ] 远程安装 Agent 不覆盖全局安装，失败给出明确原因
- [ ] 无权限用户不能修改管理面配置
- [ ] 断言与截图作为证据留存
