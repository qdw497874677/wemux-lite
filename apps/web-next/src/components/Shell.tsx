import { PaperclipNotice } from './PaperclipNotice.tsx'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { FolderKanban, Inbox, Users, Settings, Network, ArrowUpRight, LogOut, Menu, Search, X } from 'lucide-react'
import type { AppState, Application } from '../application.ts'
import { SidebarShell } from './SidebarShell.tsx'
import { Button, Input } from './primitives.tsx'
import { navigate, type Location } from '../lib/navigation.ts'
import { NavigationScrollMemory, applyMainContentScrollTop } from '../lib/navigation-scroll.ts'
import { scheduleMainContentFocus } from '../lib/main-content-focus.ts'
import { trapDialogFocus } from '../lib/dialog-focus.ts'

const legacy = [
  { label: '集群', href: '/cluster', icon: Network },
]
export function Shell({ state, app, location, children }: { state: AppState; app: Application; location: Location; children: ReactNode }) {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  const [navOpen, setNavOpen] = useState(false), [command, setCommand] = useState('')
  const mobileNav = useRef<HTMLDialogElement>(null), palette = useRef<HTMLDialogElement>(null)
  const main = useRef<HTMLElement>(null), menuButton = useRef<HTMLButtonElement>(null)
  const memory = useRef(new NavigationScrollMemory()), previous = useRef(location.key)
  const restoring = useRef<{ key: string; top: number } | null>(null)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)')
    const change = () => { setMobile(query.matches); setNavOpen(false); mobileNav.current?.close() }
    query.addEventListener('change', change); return () => query.removeEventListener('change', change)
  }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); palette.current?.showModal() } }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [])
  useLayoutEffect(() => {
    const element = main.current
    restoring.current = location.pop ? { key: location.key, top: memory.current.recall(location.key) } : null
    applyMainContentScrollTop(element, restoring.current?.top ?? 0)
    previous.current = location.key
    setNavOpen(false); mobileNav.current?.close(); palette.current?.close()
    return scheduleMainContentFocus(element)
  }, [location.key, location.pop])
  // A pop can commit before an async project list renders. Restore again after
  // loading completes, when the main column has enough height for the saved offset.
  useLayoutEffect(() => {
    if (location.pop && !state.busy && restoring.current?.key === location.key) applyMainContentScrollTop(main.current, restoring.current.top)
  }, [location.key, location.pop, state.busy])
  const navigation = <><div className="sidebar-brand"><Network aria-hidden /><strong>Wemux Lite</strong><span className="badge">新版</span></div><div className="sidebar-context"><span className="eyebrow">当前账号</span><strong>{state.account?.username}</strong></div><Button variant="outline" onClick={() => { mobileNav.current?.close(); setNavOpen(false); palette.current?.showModal() }}><Search aria-hidden />搜索与命令<kbd>⌘ K</kbd></Button><nav aria-label="主导航"><a className="nav-link" href="/next/projects" aria-current={location.path.includes('/projects') ? 'page' : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate('/next/projects') } }}><FolderKanban aria-hidden />项目</a>{[{ label: '待办', href: '/next/attention', icon: Inbox }, { label: '团队', href: '/next/teams', icon: Users }, { label: '设置', href: '/next/settings', icon: Settings }].map(({ label, href, icon: Icon }) => <a key={href} className="nav-link" href={href} aria-current={location.path === href ? 'page' : undefined} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(href) } }}><Icon aria-hidden />{label}</a>)}{legacy.map(({ label, href, icon: Icon }) => <a className="nav-link" key={href} href={href}><Icon aria-hidden />{label}<span className="legacy-label">旧版</span><ArrowUpRight aria-hidden /></a>)}</nav><div className="sidebar-bottom"><p className="muted">其他功能仍在旧版使用。新旧入口共享当前实例的数据。</p><Button variant="ghost" onClick={() => void app.logout()} disabled={state.loggingOut}><LogOut aria-hidden />退出登录</Button><PaperclipNotice /></div></>
  return <div className="app-shell"><a className="skip-link" href="#main-content">跳到主要内容</a>{!mobile && <SidebarShell open resizable className="desktop-sidebar"><div className="sidebar-content">{navigation}</div></SidebarShell>}
    <div className="main-column"><header className="topbar">{mobile && <Button variant="ghost" ref={menuButton} aria-label="打开导航" aria-expanded={navOpen} onClick={() => { mobileNav.current?.showModal(); setNavOpen(true) }}><Menu aria-hidden /></Button>}<span>控制台 <span aria-hidden>/</span> {location.path === '/next/settings' ? '设置' : location.path === '/next/attention' ? '待办' : location.path === '/next/teams' || location.path === '/next/join' ? '团队' : '项目'}</span><a href="/">旧版控制台<ArrowUpRight aria-hidden /></a></header><main id="main-content" ref={main} tabIndex={-1} onScroll={() => { if (!restoring.current || restoring.current.key !== previous.current || !state.busy) memory.current.remember(previous.current, main.current?.scrollTop ?? 0) }}>{children}</main></div>
    <dialog className="mobile-navigation" ref={mobileNav} onKeyDown={trapDialogFocus} onClose={() => { setNavOpen(false); menuButton.current?.focus() }} onClick={event => { if (event.target === event.currentTarget) mobileNav.current?.close() }}><div className="sidebar-content"><Button variant="ghost" aria-label="关闭导航" onClick={() => mobileNav.current?.close()}><X aria-hidden /></Button>{navigation}</div></dialog>
    <dialog className="command-dialog" ref={palette} onKeyDown={trapDialogFocus}><div className="dialog-heading"><h2>搜索与命令</h2><Button variant="ghost" aria-label="关闭搜索" onClick={() => palette.current?.close()}><X aria-hidden /></Button></div><label htmlFor="command-search">搜索可访问的项目</label><Input id="command-search" value={command} onChange={event => setCommand(event.target.value)} autoFocus /><div className="command-results">{state.projects.filter(project => project.name.toLowerCase().includes(command.toLowerCase())).map(project => <Button variant="ghost" key={project.id} onClick={() => navigate(`/next/projects/${encodeURIComponent(project.id)}`)}><FolderKanban aria-hidden />{project.name}</Button>)}{!state.projects.some(project => project.name.toLowerCase().includes(command.toLowerCase())) && <p>没有匹配的项目。</p>}</div><a href="/next/projects" onClick={event => { event.preventDefault(); navigate('/next/projects') }}>查看全部项目</a><p className="muted">Esc 关闭；Tab 选择结果，Enter 打开。</p></dialog>
  </div>
}
