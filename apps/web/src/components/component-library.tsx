import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TaskSummary } from '@wemux/web-contract/task-platform'
import { Bell, Check, ChevronDown, Copy, Layers, MoreHorizontal, Palette, Plus, Search, Settings2, ShieldCheck, Sparkles, Wand2 } from 'lucide-react'
import { AiPromptInput as MotokoAiPromptInput, type AiModelSelection, type AiPromptSendStatus } from './ui/ai-prompt-input-motoko.tsx'
import { Alert } from './ui/alert.tsx'
import { Avatar } from './ui/avatar.tsx'
import { Badge } from './ui/badge.tsx'
import { Button } from './ui/button.tsx'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog.tsx'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu.tsx'
import { Field, FieldDescription, FieldError, Label } from './ui/field.tsx'
import { Input } from './ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx'
import { Separator } from './ui/separator.tsx'
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from './ui/sheet.tsx'
import { Skeleton } from './ui/skeleton.tsx'
import { Spinner } from './ui/spinner.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.tsx'
import { Textarea } from './ui/textarea.tsx'
import { Toast, ToastRegion } from './ui/toast.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx'
import { TaskCard } from './task-board/task-card.tsx'
import { TaskColumn } from './task-board/task-column.tsx'
import { TaskPriorityBadge, TaskStatusBadge } from './task-board/task-status.tsx'

const sampleTask: TaskSummary = {
  id: 'task-component-library', projectId: 'design-system', title: '建立统一组件库页面', priority: 'high', status: 'in_progress', version: 3,
  assignee: { workspaceId: 'wemux', workerId: 'worker-01', agentKey: 'pi', modelId: 'gpt-5' }, origin: 'manual', linkCount: 2,
  activeRun: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z',
}

const catalog = [
  ['actions', '操作', 'Button、Dropdown Menu'],
  ['forms', '表单', 'Input、Textarea、Select、Checkbox、Field'],
  ['composer', '提示输入', 'AiPromptInput（Motoko UI）'],
  ['feedback', '反馈', 'Alert、Toast、Tooltip、Spinner、Skeleton'],
  ['surfaces', '容器', 'Card、Avatar、Separator'],
  ['navigation', '导航', 'Tabs、Dropdown Menu'],
  ['overlays', '浮层', 'Dialog、Sheet'],
  ['tokens', '设计令牌', '色彩、语义别名'],
  ['tasks', '任务工作流', 'Task Card、Task Column、Status Badge'],
] as const

const swatches: Array<[string, string]> = [
  ['primary-500', 'bg-primary-500'], ['primary-400', 'bg-primary-400'], ['primary-600', 'bg-primary-600'],
  ['success-500', 'bg-success-500'], ['warning-500', 'bg-warning-500'], ['error-500', 'bg-error-500'], ['info-500', 'bg-info-500'],
  ['badge-violet', 'bg-badge-violet-background'], ['badge-sky', 'bg-badge-sky-background'], ['badge-success', 'bg-badge-success-background'], ['badge-warning', 'bg-badge-warning-background'], ['badge-error', 'bg-badge-error-background'],
  ['background-100', 'bg-background-100'], ['card-background-100', 'bg-card-background-100'], ['background-soft-100', 'bg-background-soft-100'], ['dropdown-background', 'bg-dropdown-background'],
]

function Showcase({ id, title, source, description, children, wide }: { id: string; title: string; source: string; description: string; children: ReactNode; wide?: boolean }) {
  return <section id={`components-${id}`} className={wide ? 'component-showcase component-showcase-wide' : 'component-showcase'}>
    <header><h2>{title}<code className="component-meta">{source}</code></h2><p>{description}</p></header>
    <div className="component-preview">{children}</div>
  </section>
}

function Label2({ children }: { children: ReactNode }) { return <p className="component-label">{children}</p> }

/** 导入组件的演示：提交后按 loading → success → idle 走一遍状态机，便于观察按钮图标切换。 */
function MotokoComposerDemo() {
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<AiPromptSendStatus>('idle')
  const [selection, setSelection] = useState<AiModelSelection>({ id: 'opus-4.5', effort: 'high', context: '200K', fast: true, thinking: false })
  const [last, setLast] = useState('')
  const timers = useRef<number[]>([])
  useEffect(() => () => { for (const id of timers.current) window.clearTimeout(id) }, [])
  const submit = (text: string, next: AiModelSelection) => {
    setLast(`${text} · ${next.id}${next.effort ? ` ${next.effort}` : ''}${next.fast ? ' fast' : ''}${next.thinking ? ' thinking' : ''}`)
    setStatus('loading')
    const success = window.setTimeout(() => {
      setStatus('success')
      const idle = window.setTimeout(() => { setStatus('idle'); setValue('') }, 900)
      timers.current.push(idle)
    }, 1200)
    timers.current.push(success)
  }
  return <div className="grid w-full gap-3">
    <MotokoAiPromptInput value={value} onChange={setValue} modelSelection={selection} onModelSelectionChange={setSelection} status={status} onSubmit={submit} />
    <p className="component-label" aria-live="polite">{last ? `最近提交：${last}` : '发送后会在这里回显提交内容与模型参数'}</p>
  </div>
}

export function ComponentLibrary() {
  const [toast, setToast] = useState<'info' | 'success' | 'warning' | 'error' | null>(null)
  const [checked, setChecked] = useState(true)
  const [notify, setNotify] = useState(true)
  return <TooltipProvider delayDuration={250}><div className="component-library">
    <header className="component-library-hero">
      <div>
        <p>WEMUX INTERFACE SYSTEM</p>
        <h1>组件库</h1>
        <span>生产组件的单一视觉索引。这里展示的组件与工作台使用同一份实现，不维护平行演示版本；样式来自统一的设计令牌，深浅色主题同时生效。</span>
      </div>
      <Badge variant="outline" prefixIcon={<Layers />}>{catalog.length} 个分组</Badge>
    </header>
    <nav className="component-library-index" aria-label="组件分组">{catalog.map(([id, title, items]) => <a key={id} href={`#components-${id}`}><strong>{title}</strong><span>{items}</span></a>)}</nav>
    <main className="component-library-grid">
      <Showcase id="actions" title="操作" source="ui/button.tsx" description="填充、描边、幽灵与危险操作，含图标与尺寸档位。">
        <Label2>变体</Label2>
        <div className="flex flex-wrap items-center gap-3">
          <Button><Sparkles className="size-4" />主要操作</Button>
          <Button variant="secondary">次要操作</Button>
          <Button variant="outline"><Copy className="size-4" />复制</Button>
          <Button variant="ghost"><Settings2 className="size-4" />设置</Button>
          <Button variant="success" appearance="outline"><ShieldCheck className="size-4" />已通过</Button>
          <Button variant="destructive"><Wand2 className="size-4" />删除任务</Button>
        </div>
        <Label2>尺寸与状态</Label2>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="xs">超小</Button>
          <Button size="sm">小号</Button>
          <Button size="default">默认</Button>
          <Button size="lg">大号</Button>
          <Button size="icon" aria-label="新建"><Plus /></Button>
          <Button disabled>不可用</Button>
          <Button variant="outline" disabled>不可用</Button>
        </div>
        <Label2>菜单</Label2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline">更多操作<ChevronDown className="size-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem><Plus className="size-4" />新建资源</DropdownMenuItem>
            <DropdownMenuItem><Copy className="size-4" />复制工作区</DropdownMenuItem>
            <DropdownMenuCheckboxItem checked={notify} onCheckedChange={value => setNotify(value === true)}>接收运行通知</DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem><Settings2 className="size-4" />连接设置</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Showcase>

      <Showcase id="forms" title="表单" source="ui/input.tsx" description="文本、长文本、选择与多选，含错误和成功状态。">
        <div className="grid w-full gap-5 sm:grid-cols-2">
          <Field><Label>工作节点名称</Label><Input placeholder="例如：办公室 Mac mini" /><FieldDescription>名称会显示在集群成员列表。</FieldDescription></Field>
          <Field><Label>服务端地址</Label><Input state="error" defaultValue="192.168.1.10" /><FieldError>无法连接该地址，请检查端口。</FieldError></Field>
          <Field><Label>令牌</Label><Input state="success" defaultValue="wemux-8f3a…" /><FieldDescription>已通过校验。</FieldDescription></Field>
          <Field><Label>运行时</Label>
            <Select defaultValue="pi"><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="pi">Pi</SelectItem><SelectItem value="claude">Claude</SelectItem><SelectItem value="opencode">OpenCode</SelectItem></SelectContent></Select>
            <FieldDescription>会话绑定后不可更换。</FieldDescription>
          </Field>
          <Field className="sm:col-span-2"><Label>说明</Label><Textarea placeholder="补充上下文与验收标准" /><FieldDescription>支持 Markdown。</FieldDescription></Field>
        </div>
        <Separator />
        <div className="grid gap-3">
          <Checkbox checked={checked} onChange={event => setChecked(event.target.checked)} label="运行成功后自动进入审查" description="仍然需要人工 approve 才会归档为完成。" />
          <Checkbox defaultChecked label="接收失败告警" />
          <Checkbox disabled label="实验特性（暂不可用）" />
        </div>
      </Showcase>

      <Showcase id="composer" title="提示输入" source="ui/ai-prompt-input-motoko.tsx" description="导入自 21st.dev 的 AI 提示输入组件（Motoko UI）：旋转占位、模型与参数浮层、听写与语音模式；动效依赖 framer-motion，色彩仍走本仓库令牌。" wide>
        <MotokoComposerDemo />
      </Showcase>

      <Showcase id="feedback" title="反馈" source="ui/alert.tsx" description="状态提示、通知、上下文提示与加载占位。">
        <Alert tone="info" title="正在同步工作区">远端变更会在几秒内出现在当前视图。</Alert>
        <Alert tone="success" title="注册成功">工作节点已加入集群，可以接受任务。</Alert>
        <Alert tone="warning" title="令牌即将过期">安装命令的有效期不足 5 分钟。</Alert>
        <Alert tone="danger" title="会话中断">与工作节点的 WebSocket 已断开，正在重连。</Alert>
        <Label2>状态徽章</Label2>
        <div className="flex flex-wrap gap-2">
          <Badge>默认</Badge><Badge variant="secondary">次要</Badge><Badge color="success" prefixIcon={<Check />}>在线</Badge>
          <Badge color="warning">待审查</Badge><Badge color="error">失败</Badge><Badge color="violet">Tailscale</Badge><Badge variant="outline">未连接</Badge>
        </div>
        <Label2>通知与提示</Label2>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => setToast('info')}><Bell className="size-4" />信息通知</Button>
          <Button variant="outline" onClick={() => setToast('success')}>成功通知</Button>
          <Button variant="outline" onClick={() => setToast('warning')}>警告通知</Button>
          <Button variant="outline" onClick={() => setToast('error')}>失败通知</Button>
          <Tooltip><TooltipTrigger asChild><Button variant="ghost">悬停查看提示</Button></TooltipTrigger><TooltipContent>真实 Tooltip 组件</TooltipContent></Tooltip>
        </div>
        <Label2>加载</Label2>
        <div className="flex flex-wrap items-center gap-5">
          <Spinner size="sm" /><Spinner size="md" /><Spinner size="lg" /><Spinner size="xl" />
          <Spinner type="dotted" size="md" />
          <Spinner type="dotted-round" size="md" />
          <span className="text-sm text-text-100">default 型带 percentage，可当进度环用：</span>
          <Spinner size="md" percentage={70} />
          <div className="grid w-52 gap-2"><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /><Skeleton className="h-3 w-2/3" /></div>
        </div>
      </Showcase>

      <Showcase id="surfaces" title="容器" source="ui/card.tsx" description="卡片的分区、操作位与页脚，配合头像标识主体。">
        <div className="grid w-full gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>办公室 Mac mini</CardTitle>
              <CardDescription>worker-01 · 已连接 3 分钟</CardDescription>
              <CardAction><Badge color="success">在线</Badge></CardAction>
            </CardHeader>
            <CardContent><p className="text-sm leading-6 text-text-100">Pi · gpt-5、claude-sonnet；2 个工作区。</p></CardContent>
            <CardFooter><div className="flex gap-2"><Button size="sm" variant="outline">查看会话</Button><Button size="sm" variant="ghost">诊断</Button></div></CardFooter>
          </Card>
          <Card variant="plain">
            <CardHeader><CardTitle>待处理任务</CardTitle><CardDescription>按最近活动排序</CardDescription></CardHeader>
            <CardContent>
              <div className="flex items-center gap-3"><Avatar name="陈曦" status="online" /><div className="min-w-0"><p className="truncate text-sm font-medium text-title-50">修复工作节点重连</p><p className="text-xs text-text-100">in_review · 高优先级</p></div></div>
              <Separator className="my-3" />
              <div className="flex items-center gap-2">
                <Avatar name="Worker 01" size="xs" /><Avatar name="Worker 02" size="sm" status="busy" /><Avatar name="Worker 03" size="md" status="away" /><Avatar name="Worker 04" size="lg" status="offline" /><Avatar name="W" size="xl" />
              </div>
            </CardContent>
          </Card>
        </div>
      </Showcase>

      <Showcase id="navigation" title="导航" source="ui/tabs.tsx" description="在同一上下文内切换内容层，两种列表样式。">
        <Tabs defaultValue="overview" className="w-full">
          <TabsList><TabsTrigger value="overview">概览</TabsTrigger><TabsTrigger value="activity">活动</TabsTrigger><TabsTrigger value="settings"><Settings2 />设置</TabsTrigger></TabsList>
          <TabsContent value="overview"><div className="component-inline-panel">概览内容区域</div></TabsContent>
          <TabsContent value="activity"><div className="component-inline-panel">活动时间线区域</div></TabsContent>
          <TabsContent value="settings"><div className="component-inline-panel">配置区域</div></TabsContent>
        </Tabs>
        <Tabs defaultValue="sessions" className="w-full">
          <TabsList variant="minimal"><TabsTrigger value="sessions">会话</TabsTrigger><TabsTrigger value="runs">运行记录</TabsTrigger><TabsTrigger value="files">文件</TabsTrigger></TabsList>
          <TabsContent value="sessions"><div className="component-inline-panel">下划线样式用于页面级主标签。</div></TabsContent>
          <TabsContent value="runs"><div className="component-inline-panel">运行记录区域</div></TabsContent>
          <TabsContent value="files"><div className="component-inline-panel">文件区域</div></TabsContent>
        </Tabs>
      </Showcase>

      <Showcase id="overlays" title="浮层" source="ui/dialog.tsx" description="需要聚焦确认的短流程，以及侧边抽屉。">
        <div className="flex flex-wrap gap-3">
          <Dialog>
            <DialogTrigger asChild><Button variant="outline">打开对话框</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>确认团队操作</DialogTitle><DialogDescription>对话框使用生产环境的焦点管理与遮罩。</DialogDescription></DialogHeader>
              <p className="text-sm leading-6 text-text-100">变更会应用到当前项目及其工作区，可在活动记录中回看。</p>
              <DialogFooter><Button variant="outline">取消</Button><Button>确认</Button></DialogFooter>
            </DialogContent>
          </Dialog>
          <Sheet>
            <SheetTrigger asChild><Button variant="outline">打开抽屉</Button></SheetTrigger>
            <SheetContent side="right">
              <SheetHeader><SheetTitle>检查器</SheetTitle></SheetHeader>
              <div className="grid gap-3 p-4 text-sm text-text-100"><p>抽屉承载上下文信息，不打断主流程。</p><Separator /><p>运行、日志与产物都可以放在这里。</p></div>
              <div className="mt-auto p-4"><SheetClose asChild><Button className="w-full" variant="outline">关闭</Button></SheetClose></div>
            </SheetContent>
          </Sheet>
          <Sheet>
            <SheetTrigger asChild><Button variant="ghost">左侧抽屉</Button></SheetTrigger>
            <SheetContent side="left">
              <SheetHeader><SheetTitle>导航</SheetTitle></SheetHeader>
              <div className="grid gap-3 p-4 text-sm text-text-100"><p>左侧抽屉用于会话导航与项目切换。</p><Separator /><p>窄屏下宽度为 88vw，不影响主区滚动位置。</p></div>
              <div className="mt-auto p-4"><SheetClose asChild><Button className="w-full" variant="outline">关闭</Button></SheetClose></div>
            </SheetContent>
          </Sheet>
          <Sheet>
            <SheetTrigger asChild><Button variant="ghost">底部抽屉</Button></SheetTrigger>
            <SheetContent side="bottom">
              <SheetHeader><SheetTitle>选择工作区</SheetTitle></SheetHeader>
              <div className="grid gap-3 p-4 text-sm text-text-100"><p>底部抽屉面向触屏，间距按安全区展开。</p><Separator /><p>最多 88dvh，内部可滚动。</p></div>
              <div className="p-4 pt-0"><SheetClose asChild><Button className="w-full" variant="outline">关闭</Button></SheetClose></div>
            </SheetContent>
          </Sheet>
        </div>
      </Showcase>

      <Showcase id="tokens" title="设计令牌" source="styles.css" description="颜色与表面来自 TailGrids 令牌集，语义别名让旧类名继续生效。" wide>
        <div className="token-grid">{swatches.map(([name, className]) => <div key={name} className="token-swatch"><span aria-hidden className={`token-chip ${className}`} />{name}</div>)}</div>
        <Alert tone="default" title="单一来源">新增界面请优先复用这里的组件与令牌，再考虑扩展契约，避免为单页复制视觉实现。</Alert>
      </Showcase>

      <Showcase id="tasks" title="任务工作流" source="task-board/*" description="任务卡、状态、优先级和列容器直接复用看板组件。" wide>
        <div className="flex flex-wrap gap-2">
          {(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'] as const).map(status => <TaskStatusBadge key={status} status={status} />)}
          <TaskPriorityBadge priority="high" /><TaskPriorityBadge priority="medium" />
        </div>
        <div className="component-task-demo">
          <TaskColumn status="in_progress" count={2}>
            <TaskCard task={sampleTask} footer={<Button size="sm" variant="ghost" className="w-full">打开任务</Button>} />
            <TaskCard task={{ ...sampleTask, id: 'task-gap-worker', title: '补齐工作节点心跳超时', status: 'in_progress', priority: 'low', version: 5, linkCount: 0 }} compact />
          </TaskColumn>
          <TaskColumn status="todo" count={2} canCreate onCreate={() => {}}>
            <TaskCard task={{ ...sampleTask, id: 'task-review-run', title: '审查运行产物并决定下一步', status: 'todo', priority: 'medium', version: 1, linkCount: 0 }} compact />
            <TaskCard task={{ ...sampleTask, id: 'task-blocked-worker', title: '工作节点离线后恢复会话', status: 'todo', priority: 'high', version: 2, linkCount: 1 }} compact />
          </TaskColumn>
        </div>
      </Showcase>
    </main>
    <footer className="component-library-footer"><Search className="size-4" />组件应优先从这里复用，再扩展现有契约，避免为单页复制视觉实现。<MoreHorizontal className="ml-auto size-4" /><Palette className="size-4" /></footer>
    {toast && (
      <ToastRegion>
        <Toast
          variant={toast}
          message={{ title: '组件状态已更新', description: '示例通知来自生产 Toast 组件，按 variant 切换图标与色彩。' }}
          onClose={() => setToast(null)}
        />
      </ToastRegion>
    )}
  </div></TooltipProvider>
}