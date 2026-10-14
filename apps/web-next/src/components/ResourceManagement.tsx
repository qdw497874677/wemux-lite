import type { ResourceInventoryDTO, ResourceInventoryEntryDTO, ResourceStateAxisDTO } from '@wemux/web-contract/browser-host'
import type { ProjectClient } from './ProjectManagement.tsx'
import { useEffect, useRef, useState } from 'react'
import { Button } from './primitives.tsx'
import {
  authenticationLabels, axisTitles, classLabels, configurationLabels, distributionLabels, executionLabels, observation, type InventoryAxisName,
} from '../lib/resource-labels.ts'

type ClassKey = 'workers' | 'agents' | 'models' | 'skills' | 'presets' | 'providers'
const sections: readonly { key: ClassKey; className: ResourceInventoryEntryDTO['class'] }[] = [
  { key: 'workers', className: 'worker' },
  { key: 'agents', className: 'agent' },
  { key: 'models', className: 'model' },
  { key: 'skills', className: 'skill' },
  { key: 'presets', className: 'preset' },
  { key: 'providers', className: 'provider' },
]

/**
 * 资源管理面（只读投影）。管理员可以看到六类资源的四态；非管理员不发起请求，
 * 也不渲染任何配置动作，因为权限判定在 Server 侧，界面不重复实现授权。
 */
export function ResourceManagement({ api, administrator }: { api: ProjectClient; administrator: boolean }) {
  const [state, setState] = useState<{ api: ProjectClient; inventory: ResourceInventoryDTO | null; loading: boolean; error: string }>()
  const confirmed = useRef<{ api: ProjectClient; inventory: ResourceInventoryDTO | null } | null>(null)
  const load = useRef<() => void>(() => {})
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!administrator) return
    // 已确认的投影在重新核验期间保留，避免把「正在刷新」显示成「没有资源」。
    let inventory = confirmed.current?.api === api ? confirmed.current.inventory : null
    let loading = false
    const controller = new AbortController()
    const publish = (error = '') => setState({ api, inventory, loading, error })
    const run = async () => {
      if (controller.signal.aborted || loading) return
      loading = true
      publish()
      try {
        const next = await api.resourceInventory(controller.signal)
        if (controller.signal.aborted) return
        inventory = next
        confirmed.current = { api, inventory }
        loading = false
        publish()
      } catch (error) {
        if (controller.signal.aborted) return
        loading = false
        publish(error instanceof Error ? error.message : '加载资源清单失败，请重试。')
      }
    }
    load.current = () => { void run() }
    load.current()
    return () => { controller.abort(); load.current = () => {} }
  }, [api, administrator, revision])
  // 账号切换后旧账号的结果不得在新账号渲染前短暂出现。
  if (confirmed.current && confirmed.current.api !== api) confirmed.current = null

  if (!administrator) return <section className="account-section" aria-label="资源管理">
    <h1>资源管理</h1>
    <p role="alert">资源管理面只对实例管理员开放。当前账号不是实例管理员，因此这里不加载任何资源状态，也不能修改管理面配置。</p>
  </section>

  const current = state?.api === api ? state : undefined
  const inventory = current?.inventory ?? null
  return <section className="account-section" aria-label="资源管理">
    <h1>资源管理</h1>
    <p>四态彼此独立：已配置是 Server 的权威声明，已认证与可执行只来自 Worker 的真实探测，已分发是 Worker 的安装回执。探测缺失时如实显示未知，不用配置状态补齐。</p>
    <Button variant="outline" disabled={Boolean(current?.loading)} onClick={() => setRevision(value => value + 1)}>刷新资源清单</Button>
    {inventory && <p role="status">清单生成于 {new Date(inventory.generatedAt).toLocaleString('zh-CN')}</p>}
    {!current || current.loading ? <p role="status">正在加载资源清单…</p> : null}
    {current?.error && <p role="alert">{current.error}</p>}
    {current?.error && <Button variant="outline" disabled={Boolean(current.loading)} onClick={() => load.current()}>重试加载资源清单</Button>}
    {inventory && sections.map(section => <section key={section.key} aria-label={classLabels[section.className]}>
      <h2>{classLabels[section.className]}（{inventory[section.key].length} 项）</h2>
      {inventory[section.key].length === 0 ? <p>没有可展示的{classLabels[section.className]}条目。</p> : null}
      {inventory[section.key].length > 0 && <ul>{inventory[section.key].map(entry => <InventoryEntry key={`${section.key}:${entry.id}`} entry={entry} />)}</ul>}
    </section>)}
  </section>
}

function InventoryEntry({ entry }: { entry: ResourceInventoryEntryDTO }) {
  const identity = [entry.workerName, entry.agentKey, entry.modelId].filter((part): part is string => Boolean(part)).join('｜')
  return <li className="account-row">
    <article aria-label={`${classLabels[entry.class]} ${entry.name}`}>
      <h3>{entry.name}</h3>
      {entry.description && <p>{entry.description}</p>}
      {identity && <p>{identity}</p>}
      <p>版本：{entry.version ?? '无版本探测结果'}</p>
      <dl>
        <Axis name="configuration" label={axisTitles.configuration} state={configurationLabels[entry.configuration.state]} detail={entry.configuration.detail} observedAt={entry.configuration.observedAt} extra={entry.configuration.revision === null ? '无已发布修订' : `修订 v${entry.configuration.revision}`} />
        <Axis name="authentication" label={axisTitles.authentication} state={authenticationLabels[entry.authentication.state]} detail={entry.authentication.detail} observedAt={entry.authentication.observedAt} />
        <Axis name="distribution" label={axisTitles.distribution} state={distributionLabels[entry.distribution.state]} detail={entry.distribution.detail} observedAt={entry.distribution.observedAt} extra={entry.distribution.setRevision === null ? '无期望态版本' : `期望态 v${entry.distribution.setRevision}`} />
        <Axis name="execution" label={axisTitles.execution} state={executionLabels[entry.execution.state]} detail={entry.execution.detail} observedAt={entry.execution.observedAt} />
      </dl>
      {entry.targets.length > 0 && <div>
        <h4>目标工作节点</h4>
        <ul>{entry.targets.map(target => <li key={target.workerId}>
          <p>{target.workerName}（{target.connectionState}）</p>
          <p>{axisTitles.distribution}：{distributionLabels[target.distribution.state]}｜{target.distribution.detail}｜{observation(target.distribution.observedAt)}</p>
          <p>{axisTitles.execution}：{executionLabels[target.execution.state]}｜{target.execution.detail}｜{observation(target.execution.observedAt)}</p>
        </li>)}</ul>
      </div>}
    </article>
  </li>
}

function Axis({ name, label, state, detail, observedAt, extra }: { name: InventoryAxisName; label: string; state: string; detail: string; observedAt: string | null; extra?: string }) {
  return <div data-axis={name}>
    <dt>{label}</dt>
    <dd>{state}{extra ? `｜${extra}` : ''}｜{detail}｜{observation(observedAt)}</dd>
  </div>
}

/** 供测试与文档引用：某一轴的证据是否来自真实探测。 */
export function hasProbeEvidence(axis: ResourceStateAxisDTO<string>): boolean {
  return axis.observedAt !== null
}
