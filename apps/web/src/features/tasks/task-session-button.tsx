import { useEffect, useMemo, useRef, useState } from 'react'
import { PendingTaskSession } from '@wemux/web-client'
import type { TaskDetail } from '@wemux/web-contract/task-platform'
import type { Api } from '../../api/client.ts'
import { createIndependentTaskSession } from './task-session-create.ts'
import { Button } from '../../components/ui/button'

/** Parent keys this view by account/team/Task/location. Late results may settle storage, never another view. */
export function TaskSessionButton({ api, task, onCreated }: { api: Api; task: TaskDetail; onCreated: (id: string) => void }) {
  const pending = useMemo(() => new PendingTaskSession(() => window.sessionStorage, { ...api.taskSessionScope, projectId: task.projectId, taskId: task.id }), [api, task.projectId, task.id])
  const current = useRef(pending); current.current = pending
  const alive = useRef(true), busy = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [sending, setSending] = useState(false), [error, setError] = useState(''), [unknown, setUnknown] = useState(false)
  useEffect(() => { try { setUnknown(!!pending.read()) } catch (e) { setError((e as Error).message) } }, [pending])
  async function create() {
    if (busy.current) return
    const location = window.location.href
    const visible = () => alive.current && current.current === pending && window.location.href === location
    busy.current = true; setSending(true); setError('')
    try {
      const result = await createIndependentTaskSession(pending, api, task)
      if (visible()) { setUnknown(false); onCreated(result.session.id) }
    } catch (e) {
      if (visible()) {
        let saved = true
        try { saved = !!pending.read() } catch { /* Fail closed when stored outcome cannot be inspected. */ }
        setUnknown(saved)
        setError(`${e instanceof Error ? e.message : '创建会话失败'}${saved ? ' 原请求未确认，请重试原请求核对；不会自动换键。' : ''}`)
      }
    } finally { busy.current = false; if (visible()) setSending(false) }
  }
  return <div className="space-y-2">
    <Button variant="outline" disabled={sending || (!unknown && !task.assignee)} onClick={() => void create()}>{sending ? '正在创建任务会话…' : unknown ? '重试原任务会话请求' : '创建独立任务会话（不启动 Run）'}</Button>
    {unknown && <p className="text-xs">完整创建请求已保留在此标签页；刷新后重试仍使用原执行环境和模型，关闭标签页会清除记录。</p>}
    {error && <p role="alert">{error}</p>}
  </div>
}
