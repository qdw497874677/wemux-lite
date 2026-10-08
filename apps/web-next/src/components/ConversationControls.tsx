import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createConversationControls, randomId, type ConversationControlIntent, type ConversationControlScope, type ConversationControlSnapshot, type ConversationControls as Controls, type ConversationController } from '@wemux/web-client'
import type { ProjectClient } from './ProjectManagement.tsx'
import { conversationControlBinding, conversationControlDenial } from '../lib/conversation-control-port.ts'
import { Button } from './primitives.tsx'
import { ConversationModelSelection } from './ConversationModelSelection.tsx'

type Props = { api: ProjectClient; scope: ConversationControlScope; read: ConversationController | null }
type Active = { api: ProjectClient; key: string; controller: Controls; snapshot: ConversationControlSnapshot }
export function ConversationControls({ api, scope, read }: Props) {
  const key = JSON.stringify([scope.host, scope.accountId, scope.teamId, scope.projectId, scope.taskId, scope.sessionId])
  const valid = [scope.accountId, scope.teamId, scope.projectId, scope.taskId, scope.sessionId].every(value => !!value?.trim() && value.length <= 200 && !value.includes('\0'))
  const [active, setActive] = useState<Active | null>(null)
  const authority = useRef({ api, key, read })
  useLayoutEffect(() => {
    authority.current = { api, key, read }
    const detach = valid ? conversationControlBinding(api, scope).attach(read) : () => {}
    return () => { authority.current = { api, key, read: null }; detach() }
  }, [api, key, read, valid])
  useEffect(() => {
    if (!valid) return
    let live = true
    const controller = createConversationControls(scope, { storage: () => window.sessionStorage, port: conversationControlBinding(api, scope).port })
    const update = () => { if (live) setActive({ api, key, controller, snapshot: controller.getSnapshot() }) }
    const unsubscribe = controller.subscribe(update)
    controller.load(); update()
    return () => { live = false; unsubscribe(); controller.dispose() }
  }, [api, key, valid])
  const current = active?.api === api && active.key === key && valid && !api.controlIdentity.signal.aborted ? active : null
  const snapshot = current?.snapshot, metadata = read?.getSnapshot() ?? null
  const visible = valid && !api.controlIdentity.signal.aborted && metadata?.scope.accountId === api.taskSessionScope.account && metadata.scope.teamId === scope.teamId && metadata.scope.projectId === scope.projectId && metadata.scope.taskId === scope.taskId && metadata.scope.sessionId === scope.sessionId && metadata.session?.access.canRead && metadata.session.id === scope.sessionId && metadata.session.taskId === scope.taskId && metadata.session.projectId === scope.projectId
  const session = visible ? metadata.session : null
  const busy = snapshot?.status === 'sending', unresolved = !!snapshot?.intent && snapshot.status !== 'admitted'
  const blocked = !current || snapshot?.status === 'blocked' || snapshot?.status === 'unloaded'
  const denial = (intent: ConversationControlIntent, fresh: boolean) => conversationControlDenial(api, scope, metadata, intent, fresh)
  function run(intent?: ConversationControlIntent) {
    const a = authority.current
    if (!current || a.api !== api || a.key !== key || !a.read || api.controlIdentity.signal.aborted) return
    const now = current.controller.getSnapshot(), target = intent ?? now.intent
    if (!target || now.status === 'sending' || now.status === 'blocked' || now.status === 'unloaded' || (intent && now.intent && now.status !== 'admitted')) return
    if (conversationControlDenial(api, scope, a.read.getSnapshot(), target, !!intent)) return
    // Explicit click freezes target and identity before any storage/transport awaits. Retry never mints.
    if (intent) {
      const commandId = randomId()
      const request: ConversationControlIntent = intent.operation === 'cancel-queued'
        ? { ...intent, body: { commandId } }
        : intent.operation === 'stop-turn' ? { ...intent, body: { commandId, turnId: intent.body.turnId } }
        : intent.operation === 'select-model' ? { ...intent, body: { commandId, modelId: intent.body.modelId } }
        : { ...intent, body: { commandId, turnId: intent.body.turnId, decision: intent.body.decision } }
      void current.controller.submit(request)
    }
    else void current.controller.retry()
  }
  const stop: ConversationControlIntent | null = session?.activeTurnId ? { operation: 'stop-turn', body: { commandId: 'preview', turnId: session.activeTurnId } } : null
  return <section className="conversation-composer" aria-label="队列与 Turn 控制">
    <h4>队列与 Turn 控制</h4>
    <p>控制请求保存在同一标签页的会话存储。关闭标签页、清除存储或浏览器丢失数据后无法保证恢复。离开不会撤回请求，重新打开不会自动发送。</p>
    {!valid && <p role="alert">缺少已验证的账号标识，不能控制会话；不会使用用户名代替账号标识。</p>}
    {session && <>
      <h5>权威待执行消息（{session.queuedMessages.length}）</h5>
      <ul className="conversation-journal">{session.queuedMessages.map(message => {
        const intent: ConversationControlIntent = { operation: 'cancel-queued', submissionCommandId: message.commandId, body: { commandId: 'preview' } }
        const reason = denial(intent, true)
        return <li key={message.commandId}><p className="machine">入队 Command：{message.commandId}；Message：{message.messageId}</p><details><summary>查看排队消息正文</summary><pre>{message.content}</pre></details><Button variant="outline" disabled={blocked || busy || unresolved || !!reason} onClick={() => run(intent)} aria-label={`取消排队消息 ${message.commandId}`}>取消这条排队消息</Button>{reason && <p>{reason}</p>}</li>
      })}</ul>
      <p className="machine">当前 Turn：{session.activeTurnId ?? '无'}</p>
      {stop && <><Button variant="outline" disabled={blocked || busy || unresolved || !!denial(stop, true)} onClick={() => run(stop)} aria-label={`停止当前 Turn ${stop.body.turnId}`}>停止当前 Turn</Button>{denial(stop, true) && <p>{denial(stop, true)}</p>}</>}
      <p>停止仅针对所选 Turn，不清空后续消息。元数据和已验证 Journal 独立展示执行情况。</p>
      <section aria-label="工具审批"><h5>待决工具审批</h5>
        {metadata?.projection.pendingApprovals.length === 0 && <p>没有待决审批。</p>}
        {metadata?.projection.pendingApprovals.map(approval => <div key={JSON.stringify([approval.turnId, approval.approvalId])}>
          <p className="machine">Turn：{approval.turnId}；审批：{approval.approvalId}</p>
          <p>{approval.reason ?? '运行时请求确认此操作'}</p><pre>{JSON.stringify(approval.action, null, 2)}</pre>
          {(['approve', 'deny'] as const).map(decision => {
            const intent: ConversationControlIntent = { operation: 'resolve-approval', approvalId: approval.approvalId, body: { commandId: 'preview', turnId: approval.turnId, decision } }
            const reason = denial(intent, true)
            return <span key={decision}><Button variant="outline" disabled={blocked || busy || unresolved || !!reason} onClick={() => run(intent)}>{decision === 'approve' ? '批准操作' : '拒绝操作'}</Button>{reason && <p>{reason}</p>}</span>
          })}
        </div>)}
        <p>决定绑定此 Session、Turn 和审批。接收回执不是运行时执行成功；结果以已验证历史为准。</p>
      </section>
      <ConversationModelSelection key={key} api={api} teamId={scope.teamId} session={session} disabled={blocked || !!busy || unresolved || !!denial({ operation: 'select-model', body: { commandId: 'preview', modelId: 'preview' } }, true)} select={modelId => run({ operation: 'select-model', body: { commandId: 'preview', modelId } })} />
      {snapshot?.error && <p role="alert">{snapshot.error}</p>}
      <Button variant="outline" disabled={!current || busy} onClick={() => { if (authority.current.api === api && authority.current.key === key && authority.current.read) current?.controller.load() }}>重新读取控制请求存储</Button>
      {snapshot?.intent && <section aria-label="原控制请求"><h5>原控制请求</h5><p className="machine">控制 Command：{snapshot.intent.body.commandId}<br />{snapshot.intent.operation === 'cancel-queued' ? `取消入队 Command：${snapshot.intent.submissionCommandId}` : snapshot.intent.operation === 'stop-turn' ? `停止 Turn：${snapshot.intent.body.turnId}` : snapshot.intent.operation === 'select-model' ? `后续模型：${snapshot.intent.body.modelId}` : `审批：${snapshot.intent.approvalId}；Turn：${snapshot.intent.body.turnId}；决定：${snapshot.intent.body.decision === 'approve' ? '批准' : '拒绝'}`}</p>
        {snapshot.status === 'rejected' && <Button variant="outline" disabled={blocked || busy || !!denial(snapshot.intent, false)} onClick={() => { const a = authority.current; if (a.api === api && a.key === key && a.read) current?.controller.releaseRejected() }}>释放未接收的模型请求</Button>}
        {unresolved && snapshot.status !== 'rejected' && <><p>原控制请求尚未确认。一个未解决请求会阻止新的取消、停止、审批和模型选择，不能替换为其他消息或新 Turn。</p><Button variant="outline" disabled={blocked || busy || !!denial(snapshot.intent, false)} onClick={() => run()}>重试原控制请求</Button>{denial(snapshot.intent, false) && <p>{denial(snapshot.intent, false)}</p>}</>}
      </section>}
      {busy && <p role="status">正在核对控制请求接收结果，不代表已执行。</p>}
      {snapshot?.admission && <p role="status">控制请求已接收。这只是接收回执，不代表消息已取消、Turn 已停止、审批已执行、模型已变更或队列已清空。{unresolved && '仍需显式重试原请求以核验当前接收状态。'}</p>}
    </>}
  </section>
}
