import type { WorkspaceDTO } from '@wemux/web-contract/browser-host'
import { useCreateIntent, type ProjectClient } from './ProjectManagement.tsx'
import { useOperationLifetime } from '../lib/operation-lifetime.ts'
import { ConfirmButton } from './AccountForms.tsx'

export function WorkspaceDeletion({ api, workspace, changed }: { api: ProjectClient; workspace: WorkspaceDTO; changed: () => void }) {
  const intent = useCreateIntent(), begin = useOperationLifetime([api, workspace.id])
  return <div><p className="muted">永久移除逻辑工作区，不删除 Worker 目录或文件，路径元数据保留只读。绑定任务、历史会话/Run、组合引用或准备结束证据不足时会拒绝；不会自动取消准备。状态冲突请刷新后重新确认。</p><ConfirmButton confirm="永久删除逻辑工作区？目录和文件保留，不发送清理命令；此操作不能恢复。" act={async () => {
    const active = begin(), body = { expectedRevision: workspace.revision }
    await api.deleteWorkspace(workspace.id, workspace.revision, intent.id(body))
    if (!active()) return
    intent.complete(); changed(); return '工作区已逻辑删除，物理文件保留。'
  }}>永久删除工作区</ConfirmButton></div>
}
