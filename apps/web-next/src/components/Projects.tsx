import { useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, Copy, FolderKanban, Search } from 'lucide-react'
import { copyText, selectElementText } from '@wemux/web-client'
import type { ProjectDTO } from '@wemux/web-contract/browser-host'
import { Button, EmptyState, Input } from './primitives.tsx'
import { navigate } from '../lib/navigation.ts'

const roles = { owner: '所有者', viewer: '只读成员', contributor: '协作者', manager: '管理者' }
const scopes = { 'owner-only': '仅所有者', 'selected-members': '指定成员', team: '团队可见' }
export function ProjectList({ projects, loading = false }: { projects: ProjectDTO[]; loading?: boolean }) {
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('name')
  const visible = projects.filter(project => project.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name, 'zh') : a.accessRole.localeCompare(b.accessRole)) || a.id.localeCompare(b.id))
  return <section><div className="page-title"><div><span className="eyebrow">工作空间</span><h1>项目</h1><p>查看当前账号有权访问的项目，继续你的工作。</p></div><span className="count">{loading ? '正在核验权限' : `${projects.length} 个项目`}</span></div>
    <label className="search" htmlFor="project-search"><Search aria-hidden /><Input id="project-search" type="search" placeholder="搜索项目" value={search} onChange={event => setSearch(event.target.value)} /><span className="sr-only">搜索项目</span></label>
    <label>项目排序<select aria-label="项目排序" value={sort} onChange={event => setSort(event.target.value)}><option value="name">名称</option><option value="role">访问角色</option></select></label>
    {loading ? <p role="status">正在加载获权项目…</p> : !projects.length ? <EmptyState icon={FolderKanban} title="还没有可访问的项目" message="请联系团队管理者获取访问权限，或由实例管理员创建项目。" /> : !visible.length ? <EmptyState icon={Search} title="没有匹配的项目" message="尝试其他名称，或清除搜索条件。" action="清除搜索" onAction={() => setSearch('')} /> : <ul className="project-list">{visible.map(project => <li key={project.id}><a className="project-row" href={`/next/projects/${encodeURIComponent(project.id)}`} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(event.currentTarget.getAttribute('href')!) } }}><span className="project-icon"><FolderKanban aria-hidden /></span><span className="project-name"><strong>{project.name}</strong><span>{scopes[project.shareScope] ?? '受限访问'}</span></span><span className="role-label">{roles[project.accessRole] ?? '成员'}</span><ArrowUpRight aria-hidden /></a></li>)}</ul>}
    <p className="migration-note">新版支持项目、工作区和任务管理。其他功能仍可在旧版打开。<a href="/projects">前往旧版项目列表 <ArrowUpRight aria-hidden /></a></p></section>
}
export function ProjectSummary({ project }: { project: ProjectDTO | undefined }) {
  const text = useRef<HTMLParagraphElement>(null)
  const [notice, setNotice] = useState('')
  if (!project) return <EmptyState icon={FolderKanban} title="项目不存在或当前账号无权访问" message="此项目不在当前账号的可见列表中。请检查链接，或联系项目管理者。" action="返回项目列表" onAction={() => navigate('/next/projects')} />
  const url = `${window.location.origin}/next/projects/${encodeURIComponent(project.id)}`
  return <section><Button variant="ghost" onClick={() => navigate('/next/projects')}><ArrowLeft aria-hidden />返回项目列表</Button><div className="page-title"><div><span className="eyebrow">项目概要</span><h1>{project.name}</h1><p>以下信息来自当前宿主的获权项目列表。</p></div><FolderKanban aria-hidden /></div>
    <dl className="project-facts"><div><dt>你的角色</dt><dd>{roles[project.accessRole] ?? '成员'}</dd></div><div><dt>可见范围</dt><dd>{scopes[project.shareScope] ?? '受限访问'}</dd></div><div><dt>项目标识</dt><dd className="machine">{project.id}</dd></div></dl>
    <div className="summary-actions"><a className="button button-default" href={`/projects/${encodeURIComponent(project.id)}`}>在旧版打开项目<ArrowUpRight aria-hidden /></a><p className="muted">任务与工作区管理见下方；会话执行入口仍在迁移。</p></div>
    <section className="share-section" aria-label="项目链接"><h2>项目链接</h2><p ref={text} className="machine share-link" tabIndex={0}>{url}</p><Button variant="outline" onClick={async () => { if (await copyText(url)) setNotice('已复制项目链接。'); else { if (text.current) selectElementText(text.current); setNotice('无法自动复制。已选择链接，请按 Ctrl+C 或长按复制。') } }}><Copy aria-hidden />复制项目链接</Button><p role="status">{notice}</p></section>
  </section>
}
