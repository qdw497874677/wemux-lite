/* Derived from pingdotgg/t3code's shadcn sidebar (MIT), adapted to Base UI and Wemux Lite. */
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ComponentProps, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'
import { Button } from './button.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './sheet.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip.tsx'

const SIDEBAR_OPEN_KEY = 'wemux.sidebar.open'
const SIDEBAR_WIDTH_KEY = 'wemux.sidebar.width'
const DEFAULT_WIDTH = 248
const MIN_WIDTH = 200
const MAX_WIDTH = 360

type SidebarContextValue = {
  isMobile: boolean
  open: boolean
  openMobile: boolean
  setOpen: (open: boolean) => void
  setOpenMobile: (open: boolean) => void
  toggleSidebar: () => void
}

const SidebarContext = createContext<SidebarContextValue | null>(null)

export function useSidebar() {
  const value = useContext(SidebarContext)
  if (!value) throw new Error('useSidebar must be used within a SidebarProvider.')
  return value
}

function readStoredOpen(defaultOpen: boolean) {
  if (typeof window === 'undefined') return defaultOpen
  const stored = window.localStorage.getItem(SIDEBAR_OPEN_KEY)
  return stored === null ? defaultOpen : stored === 'true'
}

function readStoredWidth() {
  if (typeof window === 'undefined') return DEFAULT_WIDTH
  const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY))
  return Number.isFinite(stored) ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, stored)) : DEFAULT_WIDTH
}

export function SidebarProvider({ defaultOpen = true, className, style, children, ...props }: ComponentProps<'div'> & { defaultOpen?: boolean }) {
  const [open, setOpenState] = useState(() => readStoredOpen(defaultOpen))
  const [openMobile, setOpenMobile] = useState(false)
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches)
  const [width, setWidth] = useState(readStoredWidth)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const update = () => setIsMobile(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next)
    window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(next))
  }, [])
  const toggleSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(value => !value)
    else setOpen(!open)
  }, [isMobile, open, setOpen])
  const context = useMemo(() => ({ isMobile, open, openMobile, setOpen, setOpenMobile, toggleSidebar }), [isMobile, open, openMobile, setOpen, toggleSidebar])
  return <SidebarContext.Provider value={context}><div data-slot="sidebar-wrapper" data-state={open ? 'expanded' : 'collapsed'} className={cn('group/sidebar-wrapper flex min-h-0 min-w-0 flex-1', className)} style={{ '--sidebar-width': `${width}px`, '--sidebar-width-icon': '56px', ...style } as CSSProperties} data-sidebar-width={width} onPointerMove={event => {
    const target = event.target as HTMLElement
    const rail = target.closest<HTMLElement>('[data-sidebar="rail"]')
    if (!rail || rail.dataset.resizing !== 'true') return
    const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, event.clientX))
    setWidth(next)
  }} onPointerUp={event => {
    const rail = (event.target as HTMLElement).closest<HTMLElement>('[data-sidebar="rail"]')
    if (!rail || rail.dataset.resizing !== 'true') return
    rail.dataset.resizing = 'false'
    rail.releasePointerCapture(event.pointerId)
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width))
  }} {...props}>{children}</div></SidebarContext.Provider>
}

export function Sidebar({ className, children, collapsible = 'offcanvas', ...props }: ComponentProps<'aside'> & { collapsible?: 'offcanvas' | 'icon' | 'none' }) {
  const { isMobile, open, openMobile, setOpenMobile } = useSidebar()
  if (isMobile) return <Sheet open={openMobile} onOpenChange={setOpenMobile}><SheetContent side="left" showCloseButton={false} className="surface-grain w-[min(22rem,calc(100vw-12px))] max-w-none gap-0 p-0 text-sidebar-foreground"><SheetHeader className="sr-only"><SheetTitle>工作台导航</SheetTitle><SheetDescription>项目、团队、集群与会话导航</SheetDescription></SheetHeader><div className="flex h-full min-h-0 flex-col">{children}</div></SheetContent></Sheet>
  return <aside data-slot="sidebar" data-collapsible={!open ? collapsible : ''} data-state={open ? 'expanded' : 'collapsed'} className={cn('surface-grain relative hidden h-full w-(--sidebar-width) shrink-0 border-r border-sidebar-border text-sidebar-foreground transition-[width] duration-200 ease-out md:flex group-data-[state=collapsed]/sidebar-wrapper:w-(--sidebar-width-icon)', className)} {...props}><div data-slot="sidebar-inner" className="flex h-full min-h-0 w-full flex-col overflow-hidden">{children}</div></aside>
}

export function SidebarRail({ className, ...props }: ComponentProps<'button'>) {
  const { open, setOpen, toggleSidebar } = useSidebar()
  const moved = useRef(false)
  const startX = useRef(0)
  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!open) return
    moved.current = false
    startX.current = event.clientX
    event.currentTarget.dataset.resizing = 'true'
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  return <button type="button" data-sidebar="rail" aria-label={open ? '拖动调整侧栏宽度' : '展开侧栏'} title={open ? '拖动调整侧栏宽度' : '展开侧栏'} tabIndex={-1} className={cn('absolute inset-y-0 -right-2 z-30 hidden w-4 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:bg-sidebar-border after:opacity-0 after:transition-opacity after:duration-150 hover:after:opacity-100 focus-visible:after:opacity-100 md:block', !open && 'cursor-e-resize', className)} onMouseEnter={() => { if (!open) setOpen(true) }} onPointerDown={pointerDown} onPointerMove={event => { if (event.currentTarget.dataset.resizing === 'true' && Math.abs(event.clientX - startX.current) > 3) moved.current = true }} onClick={event => { if (moved.current) { event.preventDefault(); moved.current = false; return } toggleSidebar() }} {...props} />
}

export function SidebarTrigger({ className, ...props }: ComponentProps<typeof Button>) {
  const { open, toggleSidebar } = useSidebar()
  return <Button data-slot="sidebar-trigger" variant="ghost" size="icon" aria-label={open ? '收起侧栏' : '展开侧栏'} aria-pressed={open} className={cn('size-8', className)} onClick={toggleSidebar} {...props}>{open ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}</Button>
}

export function SidebarInset({ className, ...props }: ComponentProps<'main'>) { return <main data-slot="sidebar-inset" className={cn('flex min-h-0 min-w-0 flex-1 flex-col bg-background', className)} {...props} /> }
export function SidebarHeader({ className, ...props }: ComponentProps<'div'>) { return <div data-slot="sidebar-header" className={cn('flex shrink-0 flex-col gap-2 border-b border-sidebar-border p-2', className)} {...props} /> }
export function SidebarContent({ className, ...props }: ComponentProps<'div'>) { return <div data-slot="sidebar-content" className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden', className)} {...props} /> }
export function SidebarFooter({ className, ...props }: ComponentProps<'div'>) { return <div data-slot="sidebar-footer" className={cn('flex shrink-0 flex-col gap-1 border-t border-sidebar-border p-2', className)} {...props} /> }
export function SidebarGroup({ className, ...props }: ComponentProps<'div'>) { return <div data-slot="sidebar-group" className={cn('flex min-w-0 flex-col gap-1 p-2', className)} {...props} /> }
export function SidebarGroupLabel({ className, ...props }: ComponentProps<'div'>) { return <div data-slot="sidebar-group-label" className={cn('h-7 px-2 text-[11px] font-medium uppercase tracking-wide text-sidebar-muted-foreground group-data-[state=collapsed]/sidebar-wrapper:hidden', className)} {...props} /> }
export function SidebarMenu({ className, ...props }: ComponentProps<'ul'>) { return <ul data-slot="sidebar-menu" className={cn('flex min-w-0 flex-col gap-1', className)} {...props} /> }
export function SidebarMenuItem({ className, ...props }: ComponentProps<'li'>) { return <li data-slot="sidebar-menu-item" className={cn('group/menu-item relative min-w-0', className)} {...props} /> }
export function SidebarMenuButton({ isActive = false, tooltip, className, children, ...props }: ComponentProps<'button'> & { isActive?: boolean; tooltip?: string }) {
  const { isMobile, open } = useSidebar()
  const button = <button data-slot="sidebar-menu-button" data-active={isActive} className={cn('flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg px-2 text-left text-sm font-medium text-sidebar-muted-foreground transition-colors hover:bg-accent hover:text-sidebar-foreground data-[active=true]:bg-accent data-[active=true]:text-sidebar-foreground group-data-[state=collapsed]/sidebar-wrapper:size-10 group-data-[state=collapsed]/sidebar-wrapper:justify-center group-data-[state=collapsed]/sidebar-wrapper:px-0 [&>svg]:size-4 [&>svg]:shrink-0', className)} {...props}>{children}</button>
  if (!tooltip || open || isMobile) return button
  return <Tooltip><TooltipTrigger asChild>{button}</TooltipTrigger><TooltipContent side="right">{tooltip}</TooltipContent></Tooltip>
}
export function SidebarMenuLink({ isActive = false, tooltip, className, children, ...props }: ComponentProps<'a'> & { isActive?: boolean; tooltip?: string }) {
  const { isMobile, open } = useSidebar()
  const link = <a data-slot="sidebar-menu-button" data-active={isActive} className={cn('flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg px-2 text-sm font-medium text-sidebar-muted-foreground transition-colors hover:bg-accent hover:text-sidebar-foreground data-[active=true]:bg-accent data-[active=true]:text-sidebar-foreground group-data-[state=collapsed]/sidebar-wrapper:size-10 group-data-[state=collapsed]/sidebar-wrapper:justify-center group-data-[state=collapsed]/sidebar-wrapper:px-0 [&>svg]:size-4 [&>svg]:shrink-0', className)} {...props}>{children}</a>
  if (!tooltip || open || isMobile) return link
  return <Tooltip><TooltipTrigger asChild>{link}</TooltipTrigger><TooltipContent side="right">{tooltip}</TooltipContent></Tooltip>
}
export function SidebarText({ className, children, ...props }: ComponentProps<'span'>) { return <span className={cn('min-w-0 flex-1 truncate group-data-[state=collapsed]/sidebar-wrapper:hidden', className)} {...props}>{children}</span> }
