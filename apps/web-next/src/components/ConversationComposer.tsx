import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createConversationSubmission, type ConversationController, type ConversationSubmissionController, type ConversationSubmissionSnapshot, type ConversationSubmissionScope } from '@wemux/web-client'
import type { ProjectClient } from './ProjectManagement.tsx'
import { conversationSendDenial } from '../lib/conversation-send-gate.ts'
import { Button } from './primitives.tsx'

const receiptLabels = { pending: '等待接收处理', accepted: '已接受', rejected: '已拒绝', completed: '命令已完成', failed: '命令失败', cancelled: '命令已取消' }
type Props = { api: ProjectClient; scope: ConversationSubmissionScope; read: ConversationController | null }
type Active = { api: ProjectClient; key: string; controller: ConversationSubmissionController; snapshot: ConversationSubmissionSnapshot }
export function ConversationComposer({ api, scope, read }: Props) {
  const key = JSON.stringify([scope.host, scope.accountId, scope.teamId, scope.projectId, scope.taskId, scope.sessionId])
  const validScope = [scope.accountId, scope.teamId, scope.projectId, scope.taskId, scope.sessionId].every(value => !!value.trim() && value.length <= 200 && !value.includes('\0'))
  const [active, setActive] = useState<Active | null>(null)
  const [unsaved, setUnsaved] = useState<{ api: ProjectClient; key: string; text: string } | null>(null)
  const [notSent, setNotSent] = useState<{ api: ProjectClient; key: string; reason: string } | null>(null)
  const authority = useRef({ api, key, read })
  useLayoutEffect(() => { authority.current = { api, key, read }; return () => { authority.current = { api, key, read: null } } }, [api, key, read])
  useEffect(() => {
    if (!validScope) return
    let live = true
    const controller = createConversationSubmission(scope, {
      storage: () => window.sessionStorage,
      send: (sessionId, body, signal) => {
        const current = authority.current
        if (!live || current.api !== api || current.key !== key || conversationSendDenial(current.read?.getSnapshot() ?? null, scope)) throw Error('当前会话不允许发送。')
        return api.sendMessage(sessionId, body, signal)
      },
    })
    const update = () => { if (live) setActive({ api, key, controller, snapshot: controller.getSnapshot() }) }
    const unsubscribe = controller.subscribe(update)
    controller.load(); update()
    return () => { live = false; unsubscribe(); controller.dispose() }
    // Immutable scalar key represents scope, never a mutable prop object lifetime.
  }, [api, key, validScope])
  const current = active?.api === api && active.key === key && validScope ? active : null
  const snapshot = current?.snapshot
  const failedDraft = unsaved?.api === api && unsaved.key === key ? unsaved : null
  const readSnapshot = read?.getSnapshot() ?? null
  const denial = conversationSendDenial(readSnapshot, scope)
  const visible = readSnapshot?.session?.access.canRead && readSnapshot.session.id === scope.sessionId && readSnapshot.session.taskId === scope.taskId && readSnapshot.session.projectId === scope.projectId
  const unresolved = !!snapshot?.intent && !snapshot.intent.receipt
  const busy = snapshot?.status === 'sending'
  const blocked = !current || snapshot?.status === 'blocked' || snapshot?.status === 'unloaded'
  function run(retry: boolean) {
    if (!current || busy || blocked) return
    const reason = conversationSendDenial(read?.getSnapshot() ?? null, scope)
    if (reason) {
      // A live read can invalidate admission after the enabled button was rendered.
      // Report this attempt only; an older unresolved request may still be accepted.
      setNotSent({ api, key, reason })
      return
    }
    if (!retry && (unresolved || failedDraft || !snapshot?.draft.trim())) return
    setNotSent(null)
    void (retry ? current.controller.retry() : current.controller.submit())
  }
  return <section className="conversation-composer" aria-label="消息提交">
    <h4>消息提交</h4>
    <p>草稿和原请求仅保存在同一标签页的会话存储。刷新可恢复已保存内容；关闭标签页、清除存储或浏览器丢失数据后无法保证恢复。离开或关闭不会撤回已提交请求，也不会自动重发。</p>
    {!validScope && <p role="alert">会话提交身份无效，不能读取草稿或发送消息。</p>}
    {denial && <p role="status">{denial}</p>}
    {visible && <>
      {notSent?.api === api && notSent.key === key && <p role="alert">本次未发送：{notSent.reason}请在恢复后手动操作，不会自动重发。</p>}
      {snapshot?.error && <p role="alert">{snapshot.error}</p>}
      {failedDraft && <p role="alert">当前输入尚未保存，不能作为新消息发送。请恢复存储后点击保存当前输入；离开页面会丢失这部分输入。</p>}
      <form onSubmit={event => { event.preventDefault(); run(false) }}>
        <label>新消息草稿<textarea aria-label="新消息草稿" rows={5} maxLength={100000} value={failedDraft?.text ?? snapshot?.draft ?? ''} disabled={!current} onChange={event => {
          const text = event.target.value
          if (current?.controller.edit(text)) setUnsaved(null)
          else setUnsaved({ api, key, text })
        }} /></label>
        <p>{failedDraft ? '尚未保存' : snapshot?.status === 'unloaded' || !snapshot ? '正在读取草稿' : '输入按会话独立保存；新草稿不会替换未确认的原消息。'}</p>
        <Button type="submit" disabled={!!denial || blocked || busy || unresolved || !!failedDraft || !snapshot?.draft.trim()}>发送新消息</Button>
      </form>
      {failedDraft && <Button variant="outline" onClick={() => { if (current?.controller.edit(failedDraft.text)) setUnsaved(null) }}>保存当前输入</Button>}
      <Button variant="outline" disabled={!current || busy} onClick={() => current?.controller.load()}>重新读取会话存储</Button>
      {busy && <p role="status">正在核对消息接收结果，不代表执行已开始。</p>}
      {snapshot?.intent && <section aria-label="原消息请求"><h5>{unresolved ? '待确认的原消息' : '最近消息接收记录'}</h5><p className="machine">Command：{snapshot.intent.body.commandId}<br />Message：{snapshot.intent.body.messageId}</p><details><summary>查看原消息正文（{snapshot.intent.body.content.length} 字符）</summary><pre>{snapshot.intent.body.content}</pre></details>
        {unresolved && <><p>{snapshot.admission ? '已收到接收回执，但确认状态尚未持久保存。不能凭此发送新消息。' : '原消息可能已接收，结果尚未确认。仅显式重试原消息，不使用当前新草稿。'}</p><Button variant="outline" disabled={!!denial || blocked || busy} onClick={() => run(true)}>重试原消息</Button></>}
      </section>}
      {snapshot?.admission && <p role="status">消息接收回执：{receiptLabels[snapshot.admission.status]}。这只是 Command 接收或状态记录，不代表 Turn 执行成功或任务完成。</p>}
    </>}
  </section>
}
