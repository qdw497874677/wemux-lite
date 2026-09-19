/**
 * 上游词汇 → 我们组件 props 的映射表（无组件依赖，两侧页面都能读）。
 * 报告逐条列出，作为“API 差异”的证据。
 */
export const mapping: Record<string, string> = {
  'Button.variant': 'primary→default, danger→destructive, success→success, ghost→ghost',
  'Button.appearance': '原样透传 (fill|outline)',
  'Button.size': 'xs|sm|lg 原样；md→default',
  'Alert.status': 'error→tone=danger，其余同名映射到 tone',
  'Avatar.status': '原样透传 (online|busy|away|offline)，上游只有 online|offline|busy',
  'Spinner.kind': '未映射：上游是 130px 进度环，我们是 20px 旋转指示器',
  'Checkbox.label/description': '我们内置 label/description；上游只提供勾选框',
  'Card.variant': '用默认 surface（上游字面是 plain）',
  'Select.label': '上游 Select 内置 label/description/errorMessage；我们用 Field 组合',
  'Toast.placement': '我们固定到视口右下；上游交给调用方',
}