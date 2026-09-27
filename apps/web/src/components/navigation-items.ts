import { Activity, FolderGit2, LayoutDashboard, MessageSquarePlus, PlugZap, Settings2, SquareKanban } from 'lucide-react'
import type { ComponentType } from 'react'

export interface ProjectNavigationItem {
  path: 'sessions' | 'overview' | 'board' | 'workspaces' | 'activity' | 'connectors' | 'settings'
  label: string
  shortLabel: string
  icon: ComponentType<{ className?: string }>
}

/** Shared by the desktop Sidebar and compact ProjectQuickNav. */
export const projectNavigationItems: readonly ProjectNavigationItem[] = [
  { path: 'sessions', label: '新对话 / 会话', shortLabel: '对话', icon: MessageSquarePlus },
  { path: 'overview', label: '项目概览', shortLabel: '概览', icon: LayoutDashboard },
  { path: 'board', label: '任务', shortLabel: '任务', icon: SquareKanban },
  { path: 'workspaces', label: '工作区', shortLabel: '工作区', icon: FolderGit2 },
  { path: 'activity', label: '活动', shortLabel: '活动', icon: Activity },
  { path: 'connectors', label: '连接器', shortLabel: '连接器', icon: PlugZap },
  { path: 'settings', label: '项目设置', shortLabel: '设置', icon: Settings2 },
]
