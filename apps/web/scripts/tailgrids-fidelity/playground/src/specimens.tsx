import type { ReactNode } from 'react'

/** 上游 TailGrids 的 API 词汇表：样本用它描述，各 kit 适配层负责映射。 */
export type BtnVariant = 'primary' | 'danger' | 'success' | 'ghost'
export type BtnAppearance = 'fill' | 'outline'
export type BtnSize = 'xs' | 'sm' | 'md' | 'lg'
export type InputState = 'default' | 'error' | 'success'
export type BadgeColor =
  | 'gray' | 'primary' | 'error' | 'warning' | 'success' | 'cyan' | 'sky'
  | 'blue' | 'violet' | 'purple' | 'pink' | 'rose' | 'orange'
export type AlertStatus = 'default' | 'success' | 'warning' | 'error' | 'info'
export type ToastVariant = 'default' | 'success' | 'error' | 'warning' | 'info'

export type Kit = {
  id: 'upstream' | 'ours'
  label: string
  Button: (p: { variant: BtnVariant; appearance?: BtnAppearance; size?: BtnSize; children?: ReactNode; disabled?: boolean }) => ReactNode
  Input: (p: { state?: InputState; placeholder?: string; defaultValue?: string; disabled?: boolean }) => ReactNode
  TextArea: (p: { state?: InputState; placeholder?: string; rows?: number }) => ReactNode
  Badge: (p: { color: BadgeColor; size?: 'sm' | 'md' | 'lg'; children?: ReactNode }) => ReactNode
  Alert: (p: { status: AlertStatus; title: string; description: string }) => ReactNode
  Card: (p: { title: string; description: string; body: string; action?: string; footer?: string; plain?: boolean }) => ReactNode
  Tabs: (p: { variant: 'default' | 'minimal'; items: string[]; open?: boolean }) => ReactNode
  Checkbox: (p: { size: 'sm' | 'md'; checked: boolean; label?: string; description?: string }) => ReactNode
  Spinner: (p: { kind: 'default' | 'dotted' | 'dotted-round' }) => ReactNode
  Skeleton: (p: { width: string; height?: string }) => ReactNode
  Avatar: (p: { name: string; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'; status?: 'online' | 'busy' | 'away' | 'offline' }) => ReactNode
  Separator: () => ReactNode
  Field: (p: { label: string; description?: string; error?: string; state?: InputState }) => ReactNode
  Select: (p: { items: string[]; value?: string; open?: boolean; withLabel?: boolean }) => ReactNode
  Dialog: (p: { open?: boolean; title: string; description: string }) => ReactNode
  Dropdown: (p: { open?: boolean; items: string[] }) => ReactNode
  Tooltip: (p: { open?: boolean; text: string }) => ReactNode
  Sheet: (p: { open?: boolean; title: string; side?: 'left' | 'right' }) => ReactNode
  Toast: (p: { variant: ToastVariant; title: string; description: string }) => ReactNode
}

export type Clip = { x: number; y: number; width: number; height: number }

export type Spec = {
  id: string
  name: string
  group: string
  /** 弹层类：整页只渲染它，打开后按 clip 截视口 */
  overlay?: boolean
  clip?: Clip
  /**
   * 弹层样本按“面板元素”比较（元素裁剪，首个命中的选择器）。
   * 遮罩是否内置、浮层定位/偏移由各自实现决定，不在组件表面比较里计分；
   * 这些结构差异写进 deviations。
   */
  panel?: string[]
  /** 已知且经确认的结构性差异（不进像素判定，写进报告） */
  deviations?: string[]
  /**
   * 只渲染该样本时，舞台上方留出的空白（px）。
   * 给“向上弹出”的浮层留空间：上游用 floating-ui 的 flip、我们用 radix 的
   * avoidCollisions，两边都靠“上方空间不够就翻到另一侧”，样本贴着页顶时
   * 会因为需要的空间不同（上游还带 18px 箭头）而翻到不同侧，比对就不是同一件事了。
   * 该值同时要加到 spec.clip.y 上（clip 是视口坐标）。
   */
  headroom?: number
  render: (k: Kit, mode: 'inline' | 'only') => ReactNode
}

const row = (children: ReactNode, gap = 12): ReactNode => (
  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap }}>{children}</div>
)


export const specs: Spec[] = [
  {
    id: 'button-fill', name: 'Button primary/fill/md', group: 'button',
    render: (k) => row([k.Button({ variant: 'primary', appearance: 'fill', size: 'md', children: '按钮' }), k.Button({ variant: 'primary', appearance: 'fill', size: 'md', children: '禁用', disabled: true })]),
  },
  {
    id: 'button-outline', name: 'Button primary/outline/md', group: 'button',
    render: (k) => row([k.Button({ variant: 'primary', appearance: 'outline', size: 'md', children: '按钮' }), k.Button({ variant: 'primary', appearance: 'outline', size: 'md', children: '禁用', disabled: true })]),
  },
  {
    id: 'button-danger', name: 'Button danger/fill/md', group: 'button',
    render: (k) => row([k.Button({ variant: 'danger', appearance: 'fill', size: 'md', children: '删除' }), k.Button({ variant: 'danger', appearance: 'outline', size: 'md', children: '删除' })]),
  },
  {
    id: 'button-ghost', name: 'Button ghost/md', group: 'button',
    render: (k) => row([k.Button({ variant: 'ghost', size: 'md', children: '取消' }), k.Button({ variant: 'ghost', size: 'md', children: '禁用', disabled: true })]),
  },
  {
    id: 'input-default', name: 'Input default', group: 'form',
    render: (k) => <div style={{ width: 360 }}>{k.Input({ placeholder: '请输入任务标题' })}</div>,
  },
  {
    id: 'input-error', name: 'Input error', group: 'form',
    render: (k) => <div style={{ width: 360 }}>{k.Input({ state: 'error', defaultValue: 'task-001' })}</div>,
  },
  {
    id: 'textarea-default', name: 'TextArea default', group: 'form',
    render: (k) => <div style={{ width: 360 }}>{k.TextArea({ placeholder: '补充说明' })}</div>,
  },
  {
    id: 'field-stack', name: 'Field + Label + Description', group: 'form',
    deviations: ['上游无 FieldError 组件，错误文案由 react-aria 校验态渲染'],
    render: (k) => <div style={{ width: 360 }}>{k.Field({ label: '会话标题', description: '用于在看板中识别' })}</div>,
  },
  {
    id: 'badge-row', name: 'Badge 色板 (md)', group: 'display',
    render: (k) => row(['gray', 'primary', 'success', 'warning', 'error'].map((c) => k.Badge({ key: c, color: c as BadgeColor, size: 'md', children: '标签' }))),
  },
  {
    id: 'alert-info', name: 'Alert info', group: 'display',
    render: (k) => <div style={{ width: 620 }}>{k.Alert({ status: 'info', title: '有新版本可用', description: 'Worker 0.4.1 已发布，重启后生效。' })}</div>,
  },
  {
    id: 'alert-error', name: 'Alert error', group: 'display',
    render: (k) => <div style={{ width: 620 }}>{k.Alert({ status: 'error', title: '连接失败', description: 'Tailscale 地址不可达，已回退直连。' })}</div>,
  },
  {
    id: 'card', name: 'Card 默认变体 (header/title/description/action/content/footer)', group: 'display',
    deviations: ['我们用 variant=surface（带边框与卡片底色）；上游 Card 本体是 variant=plain 的 TailGrids 字面量'],
    render: (k) => <div style={{ width: 420 }}>{k.Card({ title: '规划会话', description: 'Workspace: wemux-mini', body: '会话已绑定 worker-01 的 pi 运行时。', action: '进行中', footer: '更新于 3 分钟前' })}</div>,
  },
  {
    id: 'card-plain', name: 'Card plain 变体（TailGrids 字面量）', group: 'display',
    render: (k) => <div style={{ width: 420 }}>{k.Card({ plain: true, title: '规划会话', description: 'Workspace: wemux-mini', body: '会话已绑定 worker-01 的 pi 运行时。', action: '进行中', footer: '更新于 3 分钟前' })}</div>,
  },
  {
    id: 'tabs-default', name: 'Tabs default (horizontal)', group: 'navigation',
    render: (k) => <div style={{ width: 420 }}>{k.Tabs({ variant: 'default', items: ['概览', '会话', '审查'], open: true })}</div>,
  },
  {
    id: 'tabs-minimal', name: 'Tabs minimal (horizontal)', group: 'navigation',
    render: (k) => <div style={{ width: 420 }}>{k.Tabs({ variant: 'minimal', items: ['概览', '会话', '审查'], open: true })}</div>,
  },
  {
    id: 'checkbox-md', name: 'Checkbox md checked（只比勾选框）', group: 'form',
    deviations: ['上游 Checkbox 只有勾选框，标签/描述由调用方组合；我们内置 label/description（超集）'],
    render: (k) => k.Checkbox({ size: 'md', checked: true }),
  },
  {
    id: 'checkbox-sm', name: 'Checkbox sm checked（只比勾选框）', group: 'form',
    deviations: ['同上：我们内置 label/description'],
    render: (k) => k.Checkbox({ size: 'sm', checked: true }),
  },
  {
    id: 'spinner-default', name: 'Spinner default（进度环 50%）', group: 'feedback',
    render: (k) => row([k.Spinner({ kind: 'default' })]),
  },
  {
    id: 'spinner-dotted', name: 'Spinner dotted（点阵环）', group: 'feedback',
    render: (k) => row([k.Spinner({ kind: 'dotted' })]),
  },
  {
    id: 'spinner-dotted-round', name: 'Spinner dotted-round（点阵圆点环）', group: 'feedback',
    render: (k) => row([k.Spinner({ kind: 'dotted-round' })]),
  },
  {
    id: 'skeleton', name: 'Skeleton', group: 'feedback',
    render: (k) => <div style={{ width: 360, display: 'grid', gap: 10 }}>{k.Skeleton({ width: '100%' })}{k.Skeleton({ width: '60%' })}</div>,
  },
  {
    id: 'avatar', name: 'Avatar lg + status', group: 'display',
    render: (k) => row([k.Avatar({ name: 'Wemux Worker', size: 'lg', status: 'online' }), k.Avatar({ name: 'Pi Agent', size: 'md', status: 'busy' })]),
  },
  {
    id: 'separator', name: 'Separator horizontal', group: 'display',
    render: (k) => <div style={{ width: 360 }}>{k.Separator()}</div>,
  },
  {
    id: 'select-closed', name: 'Select 关闭态（触发器 + 指示器）', group: 'form',
    deviations: [
      '上游 single Select 的 label prop 渲染为 sr-only（可见标签由 Field 组合，见 field-stack 样本），我们同样不把标签画进控件；上游另带一个隐藏的原生 select 做表单回填，我们靠受控 state 回填',
      '上游指示器是独立 SelectIndicator（需调用方组合），我们把箭头内置在触发器里',
    ],
    render: (k) => <div style={{ width: 360 }}>{k.Select({ items: ['pi', 'claude'], value: 'pi', withLabel: true })}</div>,
  },
  {
    id: 'toast-surface', name: 'Toast 表面 (placement 已归一)', group: 'feedback', overlay: true,
    clip: { x: 940, y: 560, width: 480, height: 320 },
    deviations: ['我们固定到视口右下并带关闭按钮；上游把 placement 交给调用方，且支持 undoAction'],
    render: (k, mode) => k.Toast({ variant: 'success', title: '已加入集群', description: 'worker-02 已上线' }),
  },
  {
    id: 'dialog-open', name: 'Dialog 打开态', group: 'overlay', overlay: true,
    clip: { x: 400, y: 250, width: 640, height: 400 },
    panel: ['[role="dialog"]', 'section.fixed'],
    render: (k, mode) => <div style={{ width: 200 }}>{k.Dialog({ open: mode === 'only', title: '删除工作区', description: '该操作不可撤销。', })}</div>,
  },
  {
    id: 'dropdown-open', name: 'Dropdown 打开态', group: 'overlay', overlay: true,
    clip: { x: 200, y: 40, width: 440, height: 300 },
    panel: ['[role="menu"]', '[role="dialog"]'],
    render: (k, mode) => <div style={{ width: 220 }}>{k.Dropdown({ open: mode === 'only', items: ['重命名', '复制链接', '删除'] })}</div>,
  },
  {
    id: 'tooltip-open', name: 'Tooltip 打开态', group: 'overlay', overlay: true,
    // clip.y 已含 headroom（296 + 40）
    headroom: 296,
    clip: { x: 180, y: 336, width: 480, height: 300 },
    panel: ['[role="tooltip"]'],
    deviations: [
      '上游用 floating-ui，气泡反侧还有一个 FloatingArrow 小箭头；我们不渲染箭头（radix 的 Arrow 会把气泡再推开 18px，比复刻那条 5px 窄条更偏离上游观感）',
      '给足上方空间后两侧几何完全一致：气泡 y/x/宽高与到触发的 10px 间距相同（probe-geo3 实测）',
    ],
    render: (k, mode) => <div style={{ width: 200 }}>{k.Tooltip({ open: mode === 'only', text: '会话固定绑定该模型' })}</div>,
  },
  {
    id: 'sheet-open', name: 'Sheet/Drawer 打开态 (left)', group: 'overlay', overlay: true,
    clip: { x: 0, y: 0, width: 380, height: 620 },
    panel: ['[role="dialog"]', '.fixed.w-80'],
    render: (k, mode) => <div style={{ width: 200 }}>{k.Sheet({ open: mode === 'only', title: '会话列表', side: 'left' })}</div>,
  },
]

export const specById = (id: string) => specs.find((s) => s.id === id)