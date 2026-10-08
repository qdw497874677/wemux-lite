# Triage Labels

技能集以五个规范分诊角色沟通。本文件把角色映射到本仓库票据实际使用的标签字符串。

本仓库用本地 markdown tracker（见 `issue-tracker.md`），标签字符串用作票据文件 `Status:` 行的角色值。

| mattpocock/skills 中的角色 | 本仓库使用的字符串 | 含义                             |
| -------------------------- | ------------------ | -------------------------------- |
| `needs-triage`             | `needs-triage`     | 维护者需要评估这个 issue          |
| `needs-info`               | `needs-info`       | 等待报告者补充信息                |
| `ready-for-agent`          | `ready-for-agent`  | 已完全规格化，可交给 AFK agent    |
| `ready-for-human`          | `ready-for-human`  | 需要人来实现                      |
| `wontfix`                  | `wontfix`          | 不予处理                          |

当 skill 提到某个角色（如 "apply the AFK-ready triage label"）时，使用表中对应的字符串。

要换用别的词汇，编辑「本仓库使用的字符串」一列即可。
