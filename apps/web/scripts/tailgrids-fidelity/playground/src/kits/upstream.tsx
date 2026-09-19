import type { ReactNode } from 'react'
import { Button as UpButton } from '@up/button'
import { Input as UpInput } from '@up/input'
import { TextArea as UpTextArea } from '@up/text-area'
import { Badge as UpBadge } from '@up/badge'
import { Alert as UpAlert, AlertContent, AlertDescription, AlertIndicator, AlertTitle } from '@up/alert'
import { Card as UpCard, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@up/card'
import { TabContent, TabList, TabRoot, TabTrigger } from '@up/tabs'
import { Checkbox as UpCheckbox } from '@up/checkbox'
import { Spinner as UpSpinner } from '@up/spinner'
import { Skeleton as UpSkeleton } from '@up/skeleton'
import { Avatar as UpAvatar, AvatarBadge, AvatarFallback } from '@up/avatar'
import { Separator as UpSeparator } from '@up/separator'
import { FieldGroup, FieldLabel } from '@up/field'
import { Description } from '@up/description'
import { Select as UpSelect, SelectContent, SelectIndicator, SelectItem, SelectTrigger, SelectValue as SelectDisplayValue } from '@up/select'
import { Dialog as UpDialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@up/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@up/dropdown'
import { Backdrop } from '@up/overlay'
import { Tooltip, TooltipContent, TooltipTrigger } from '@up/tooltip'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@up/sheet'
import { Toast as UpToast } from '@up/toast'
import type { Kit } from '../specimens'

/**
 * 上游参照 kit：全部调用 @tailgrids/registry 原始源码，不改样式，
 * 只在必要时组装（上游把 label/description 留给组合方）。
 */
export const upstreamKit: Kit = {
  id: 'upstream',
  label: 'TailGrids 原始组件',
  Button: ({ variant, appearance = 'fill', size = 'md', children, disabled }) => (
    <UpButton variant={variant} appearance={appearance} size={size} isDisabled={disabled}>
      {children}
    </UpButton>
  ),
  Input: ({ state, placeholder, defaultValue, disabled }) => (
    <UpInput state={state} placeholder={placeholder} defaultValue={defaultValue} disabled={disabled} />
  ),
  TextArea: ({ state, placeholder, rows }) => (
    <UpTextArea state={state} placeholder={placeholder} rows={rows ? String(rows) as unknown as number : undefined} />
  ),
  Badge: ({ color, size = 'md', children }) => (
    <UpBadge color={color} size={size}>
      {children}
    </UpBadge>
  ),
  Alert: ({ status, title, description }) => (
    <UpAlert status={status}>
      <AlertIndicator />
      <AlertContent>
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </AlertContent>
    </UpAlert>
  ),
  Card: ({ title, description, body, action, footer }) => (
    <UpCard>
      <CardHeader>
        {action ? <CardAction>{action}</CardAction> : null}
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
      {footer ? <CardFooter>{footer}</CardFooter> : null}
    </UpCard>
  ),
  Tabs: ({ variant, items, open }) => (
    /* 上游 Tabs 的 API 是 defaultValue + 每个 trigger 的 value（早期版本的 defaultSelectedKey/id 是错的，会让三个 tab 全部进入 active）。 */
    <TabRoot defaultValue="0" variant={variant} direction="horizontal">
      <TabList aria-label="样本" variant={variant} direction="horizontal">
        {items.map((item, i) => (
          <TabTrigger key={item} value={String(i)}>
            {item}
          </TabTrigger>
        ))}
      </TabList>
      <TabContent value="0">{`${items[0]}内容`}</TabContent>
    </TabRoot>
  ),
  Checkbox: ({ size, checked }) => <UpCheckbox size={size} defaultChecked={checked} />,
  Spinner: ({ kind = 'default' }) => <UpSpinner size="md" type={kind} />,
  Skeleton: ({ width, height }) => <UpSkeleton style={{ width, height: height ?? 12 }} />,
  Avatar: ({ name, size = 'md', status }) => (
    <UpAvatar size={size}>
      <AvatarFallback>{initials(name)}</AvatarFallback>
      {status ? <AvatarBadge status={status === 'away' ? 'busy' : status} size={size} /> : null}
    </UpAvatar>
  ),
  Separator: () => <UpSeparator />,
  Field: ({ label, description }) => (
    <FieldGroup>
      <FieldLabel>{label}</FieldLabel>
      <UpInput placeholder="请输入" />
      {description ? <Description>{description}</Description> : null}
    </FieldGroup>
  ),
  Select: ({ items, value, open, withLabel }) => (
    <UpSelect label={withLabel ? 'Agent' : undefined} items={items} defaultSelectedKey={value} onSelectionChange={() => {}}>
      <SelectTrigger>
        <SelectDisplayValue />
        <SelectIndicator />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item} id={item}>
            {item}
          </SelectItem>
        ))}
      </SelectContent>
    </UpSelect>
  ),
  Dialog: ({ open, title, description }) => (
    // 上游 Dialog 自身不带遮罩：遮罩是独立的 Backdrop 组件（registry/overlay）。
    // 这里按上游 alert-dialog 的组装方式补上，才能与「内置遮罩」的我们逐像素比对。
    <Backdrop defaultOpen={open} isDismissable={false}>
      <UpDialog defaultOpen={open} showCloseButton>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>该工作区下的会话记录会一并移除。</DialogBody>
        <DialogFooter>
          <UpButton appearance="outline" variant="primary">取消</UpButton>
          <UpButton variant="danger">删除</UpButton>
        </DialogFooter>
      </UpDialog>
    </Backdrop>
  ),
  Dropdown: ({ open, items }) => (
    <DropdownMenu defaultOpen={open}>
      <DropdownMenuTrigger>打开菜单</DropdownMenuTrigger>
      <DropdownMenuContent>
        {items.map((item) => (
          <DropdownMenuItem key={item}>{item}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ),
  Tooltip: ({ open, text }) => (
    <Tooltip initialOpen={open} placement="top">
      <TooltipTrigger>
        <span style={{ display: 'inline-block' }}>悬停查看</span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  ),
  Sheet: ({ open, title, side = 'left' }) => (
    <Sheet defaultOpen={open}>
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
      <UpToast variant={variant === 'default' ? 'default' : variant} message={{ title, description }} />
    </div>
  ),
}

function initials(name: string) {
  const words = name.trim().split(/\s+/)
  return (words.length > 1 ? words[0][0] + words[1][0] : name.trim().slice(0, 2)).toUpperCase()
}

export type { ReactNode }