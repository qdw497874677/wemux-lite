export const emptySessionSuggestions = ['查看这个工作区里有什么', '帮我梳理项目结构', '运行测试并总结结果', '解释最近的改动'] as const

export function applySessionSuggestion(controller: { edit: (draft: string) => void }, input: { focus: () => void } | null, suggestion: string) {
  controller.edit(suggestion)
  input?.focus()
}
