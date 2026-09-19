import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Alert } from '@/components/ui/alert'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import { Field, FieldDescription, FieldError, Label } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Toast } from '@/components/ui/toast'
import type { Kit } from '../specimens'

export const oursKit: Kit = {
  id: 'ours',
  label: 'Wemux 实现',
  Button: ({ variant, appearance = 'fill', size = 'md', children, disabled }) => (
    <Button
      variant={variant === 'primary' ? 'default' : variant === 'danger' ? 'destructive' : variant}
      appearance={appearance}
      size={size === 'md' ? 'default' : size}
      disabled={disabled}
    >
      {children}
    </Button>
  ),
  Input: ({ state, placeholder, defaultValue, disabled }) => (
    <Input state={state} placeholder={placeholder} defaultValue={defaultValue} disabled={disabled} />
  ),
  TextArea: ({ state, placeholder, rows }) => <Textarea state={state} placeholder={placeholder} rows={rows} />,
  Badge: ({ color, size = 'md', children }) => (
    <Badge color={color} size={size}>
      {children}
    </Badge>
  ),
  Alert: ({ status, title, description }) => (
    <Alert tone={status === 'error' ? 'danger' : status} title={title}>
      {description}
    </Alert>
  ),
  Card: ({ title, description, body, action, footer }) => (
    <Card>
      <CardHeader>
        {action ? <CardAction>{action}</CardAction> : null}
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
      {footer ? <CardFooter>{footer}</CardFooter> : null}
    </Card>
  ),
  Tabs: ({ variant, items }) => (
    <Tabs defaultValue="0" variant={variant} direction="horizontal">
      <TabsList>
        {items.map((item, i) => (
          <TabsTrigger key={item} value={String(i)}>
            {item}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="0">{items[0]}内容</TabsContent>
    </Tabs>
  ),
  Checkbox: ({ size, checked, label, description }) => (
    <Checkbox size={size} defaultChecked={checked} label={label || undefined} description={description} />
  ),
  Spinner: ({ kind = 'default' }) => <Spinner size="md" type={kind} percentage={50} />,
  Skeleton: ({ width, height }) => <Skeleton style={{ width, height: height ?? 12 }} />,
  Avatar: ({ name, size = 'md', status }) => <Avatar name={name} size={size} status={status} />,
  Separator: () => <Separator />,
  Field: ({ label, description, error, state }) => (
    <Field>
      <Label>{label}</Label>
      <Input state={state} placeholder="请输入" />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  ),
  Select: ({ items, value, withLabel }) => {
    const select = (
      <Select value={value}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item} value={item}>
              {item}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
    // 上游 single Select 的 label 渲染为 sr-only（可见标签靠 Field 组合，见 field-stack 样本）；
    // 我们同样不把标签画进控件，保持与上游同解剖。
    void withLabel
    return select
  },
  Dialog: ({ open, title, description }) => (
    <Dialog open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>该工作区下的会话记录会一并移除。</DialogBody>
        <DialogFooter>
          <Button appearance="outline" variant="default">
            取消
          </Button>
          <Button variant="destructive">删除</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  Dropdown: ({ open, items }) => (
    <DropdownMenu open={open}>
      {/* 与上游一致：触发器是裸 button，不加按钮外观 */}
      <DropdownMenuTrigger>打开菜单</DropdownMenuTrigger>
      <DropdownMenuContent>
        {items.map((item) => (
          <DropdownMenuItem key={item}>{item}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ),
  Tooltip: ({ open, text }) => (
    <Tooltip open={open}>
      {/* 与上游同解剖：触发器是 button，里面套一个 inline-block 的 span。 */}
      <TooltipTrigger>
        <span style={{ display: 'inline-block' }}>悬停查看</span>
      </TooltipTrigger>
      <TooltipContent side="top">{text}</TooltipContent>
    </Tooltip>
  ),
  Sheet: ({ open, title, side = 'left' }) => (
    <Sheet open={open}>
      <SheetContent side={side}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div style={{ padding: 16 }}>worker-01 pi</div>
      </SheetContent>
    </Sheet>
  ),
  Toast: ({ variant, title, description }) => (
    <div style={{ position: 'fixed', right: 20, bottom: 20 }}>
      <Toast variant={variant === 'default' ? 'success' : variant} message={{ title, description }} onClose={() => {}} />
    </div>
  ),
}