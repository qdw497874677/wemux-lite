import type { FormEvent } from 'react'
import { randomId } from '@wemux/web-client'
import type { ProjectDTO, WorkerDTO } from '@wemux/web-contract/browser-host'
import type { TaskDetail } from '@wemux/web-contract/task-platform'
import type { DispatchClaimState, DispatchWaitingReason, MachineScope } from '@wemux/web-contract/task-dispatch'
import { useAccountData, useAction } from './AccountForms.tsx'
import { Button } from './primitives.tsx'
import type { ProjectClient } from './ProjectManagement.tsx'

/** 等待原因由服务端判定后原样投给界面；这里只负责措辞，不重新推导可派发性。 */
export const waitingReasonLabels: Record<DispatchWaitingReason, string> = {
  intent_not_dispatchable: '这次执行意图不由当前任务状态消费（保持原状态等待，不会换机启动）。',
  scope_excluded: '机器范围里的机器没有一台在候选内。',
  worker_unauthorized: '范围内的机器没有本次执行的使用授权。',
  worker_unqualified: '范围内的机器缺少可用的执行环境（运行时、模型或落点未就绪）。',
  stale_generation: '这次申领针对过期的接替代次，不会越过交接边界启动。',
  prior_execution_in_flight: '被接替的执行还未确认停止或完成对账，接手保持等待。',
  already_claimed: '这次执行意图已被其他承接占用。',
  no_capacity: '范围内的机器执行容量已满，等待释放后按入队顺序重新匹配。',
  no_candidate: '当前没有合格且有余量的候选机器，任务保持原状态并显示原因。',
}
export const claimStateLabels: Record<DispatchClaimState, string> = { reserved: '已预约未确认', accepted: '已确认承接', unknown: '已承接但结果未知', released: '已释放' }
export const intentStateLabels: Record<'pending' | 'claimed' | 'cancelled', string> = { pending: '待承接', claimed: '已被承接', cancelled: '已随任务状态撤销' }
export const scopeKindLabels: Record<MachineScope['kind'], string> = { any: '任意获权机器', candidates: '候选机器集合', fixed: '固定机器' }

export function machineName(workers: readonly WorkerDTO[], workerId: string): string {
  return workers.find(worker => worker.id === workerId)?.name ?? workerId
}
export function scopeText(scope: MachineScope, workers: readonly WorkerDTO[]): string {
  if (scope.kind === 'any') return scopeKindLabels.any
  if (scope.kind === 'fixed') return `固定机器：${machineName(workers, scope.workerId)}`
  return `候选机器：${scope.workerIds.map(workerId => machineName(workers, workerId)).join('、')}`
}

/**
 * 机器范围与派发：范围只决定「哪些机器可以申领」，执行意图与承接记录按持久顺序展示。
 * 没有承接就不会启动，因此这里没有独立的入队开关；任务进入待处理即自动建立意图。
 */
export function TaskDispatch({ api, project, task, workers, writable, changed }: { api: ProjectClient; project: ProjectDTO; task: TaskDetail; workers: readonly WorkerDTO[]; writable: boolean; changed: () => void }) {
  const state = useAccountData(() => api.taskDispatch(project.id, task.id), [api, project.id, task.id])
  const action = useAction()
  const view = state.data
  const scope: MachineScope = view?.machineScope ?? task.machineScope ?? { kind: 'any' }
  const selectedWorkers = scope.kind === 'any' ? [] : scope.kind === 'fixed' ? [scope.workerId] : [...scope.workerIds]
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const kind = String(data.get('action') ?? 'scope')
    const shape = String(data.get('kind') ?? 'any')
    const workerIds = data.getAll('workerIds').map(value => String(value)).filter(value => value !== '')
    void action.run(async () => {
      if (shape !== 'any' && !workerIds.length) throw Error('请至少选择一台机器。')
      const machineScope: MachineScope = shape === 'any' ? { kind: 'any' } : shape === 'fixed' ? { kind: 'fixed', workerId: workerIds[0]! } : { kind: 'candidates', workerIds }
      const requestId = randomId()
      if (kind === 'dispatch') await api.arrangeDispatch(project.id, task.id, { requestId, version: task.version, machineScope })
      else if (kind === 'handoff') await api.arrangeHandoff(project.id, task.id, { requestId, version: task.version, machineScope })
      else await api.setMachineScope(project.id, task.id, { requestId, version: task.version, scope: machineScope })
      changed()
      return kind === 'dispatch' ? '已按当前机器范围安排这次执行；是否启动由承接该意图的机器决定。' : kind === 'handoff' ? '已安排新 Session 接手；旧执行对账完成后才会被承接。' : '机器范围已更新，已建 Session 不受影响。'
    })
  }
  return <section className="task-dispatch">
    <h3>机器范围与派发</h3>
    {state.feedback}
    {view && <>
      <p>机器范围：{scopeText(scope, workers)}</p>
      {view.claim
        ? <p role="status">执行承接：{machineName(workers, view.claim.workerId)} · {claimStateLabels[view.claim.state]}{view.claim.releasedReason ? `（${view.claim.releasedReason}）` : ''}</p>
        : view.intent
          ? <p>执行意图：第 {view.intent.generation + 1} 次安排 · 入队序 {view.intent.queueOrder} · {intentStateLabels[view.intent.state]}</p>
          : <p>还没有执行意图：任务进入待处理时自动建立，不需要额外的入队开关。</p>}
      {!view.claim && view.intent && view.waitingReason && <p role="status">等待派发：{waitingReasonLabels[view.waitingReason]}</p>}
      {view.claim?.state === 'unknown' && <p className="muted">结果未知的执行继续占用该意图：平台不凭超时判失败，也不换机器重复启动，需先核对进程与执行记录。</p>}
      {view.intent?.supersedes && <p className="muted">接手意图绑定被接替的承接（第 {view.intent.supersedes.generation + 1} 代）；旧执行未释放前不会启动。</p>}
      <p className="muted">范围只是候选过滤：机器仍要自行核对运行时、模型、落点与容量后按自身身份申领；修改范围不会换绑已建立的 Session。</p>
    </>}
    {writable && <form className="account-form" onSubmit={submit}>
      <fieldset disabled={action.busy}>
        <label>操作<select name="action" defaultValue="scope"><option value="scope">只更新机器范围</option>{task.status === 'todo' && <option value="dispatch">按当前范围安排这次执行</option>}{task.status === 'in_progress' && <option value="handoff">安排新 Session 接手</option>}</select></label>
        <label>范围形态<select name="kind" defaultValue={scope.kind}>{Object.entries(scopeKindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label>机器（可多选，按住 Ctrl 或长按多选）<select name="workerIds" multiple size={Math.max(1, Math.min(4, workers.length))} defaultValue={selectedWorkers}>{workers.map(worker => <option value={worker.id} key={worker.id}>{worker.name}（{worker.connectionState}）</option>)}</select></label>
        <Button type="submit">提交机器范围与派发操作</Button>
      </fieldset>
      {action.feedback}
    </form>}
  </section>
}
