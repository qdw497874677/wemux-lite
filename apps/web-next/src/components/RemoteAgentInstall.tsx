import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import { copyText, selectElementText } from '@wemux/web-client'
import type { ManagedAgentCatalogDTO, ManagedAgentInstallDTO, ResourceInventoryDTO } from '@wemux/web-contract/browser-host'
import type { ProjectClient } from './ProjectManagement.tsx'
import { ConfirmButton, accountError } from './AccountForms.tsx'
import { Button, Input } from './primitives.tsx'
import { buildManagedAgentInstallCommand, defaultAgentInstallDirectory } from '../lib/agent-install.ts'
import { axisTitles, configurationLabels, distributionLabels, executionLabels, observation } from '../lib/resource-labels.ts'

/**
 * 托管安装 Agent（管理员入口）。
 *
 * 两条路径共用同一份固定版本清单（Server 与 Worker 同源），语义严格区分：
 * - 在线节点：提交受审计的下发请求，只创建托管修订与绑定；安装是否发生由 Worker 回执决定，
 *   界面的四态投影照抄 Server 的判定，不把「已提交」当作「已安装」。
 * - 离线/自托管节点：只展示可粘贴的一键命令（下载脚本 -> 校验 sha512 -> 安装到指定目录）。
 *   展示命令不等于已安装；命令里的失败原因只来自 Worker 的真实探测。
 * 任何安装都必须由管理员在确认对话框里显式同意，界面不会自动安装。
 */
export function RemoteAgentInstall({ api, inventory, onChanged }: { api: ProjectClient; inventory: ResourceInventoryDTO | null; onChanged: () => void }) {
  const [catalog, setCatalog] = useState<ManagedAgentCatalogDTO | null>(null)
  const [catalogError, setCatalogError] = useState('')
  const [revision, setRevision] = useState(0)
  const [workerId, setWorkerId] = useState('')
  const [agentKey, setAgentKey] = useState('')
  const [serverUrl, setServerUrl] = useState(() => (typeof window === 'undefined' ? '' : window.location.origin))
  const [extraCandidates, setExtraCandidates] = useState('')
  const [workerHome, setWorkerHome] = useState('$HOME/.wemux-lite')
  const [installDir, setInstallDir] = useState('')
  const [transport, setTransport] = useState<'direct' | 'nc'>('direct')
  const [submitted, setSubmitted] = useState<(ManagedAgentInstallDTO & { at: string }) | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [copyNotice, setCopyNotice] = useState('')
  const command = useRef<HTMLPreElement>(null)
  const changed = useRef(onChanged)
  changed.current = onChanged

  useEffect(() => {
    const controller = new AbortController()
    setCatalogError('')
    // 客户端接口缺失也不能拖倒整个资源管理页：调用与等待都在 try 内。
    const load = async () => {
      try {
        const value = await api.managedAgentCatalog(controller.signal)
        if (!controller.signal.aborted) setCatalog(value)
      } catch (cause) {
        if (!controller.signal.aborted) setCatalogError(accountError(cause))
      }
    }
    void load()
    return () => controller.abort()
  }, [api, revision])

  // 提交后轮询清单等待回执；只在两处停止：Worker 给出结论，或超时后交给手动刷新。
  useEffect(() => {
    if (!waiting) return
    const interval = setInterval(() => changed.current(), 4000)
    const stop = setTimeout(() => setWaiting(false), 45000)
    return () => { clearInterval(interval); clearTimeout(stop) }
  }, [waiting])

  const workers = (inventory?.workers ?? []).map(entry => ({ id: entry.workerId ?? entry.id, name: entry.name, connectionState: entry.connectionState }))
  const effectiveWorkerId = workers.some(worker => worker.id === workerId) ? workerId : workers[0]?.id ?? ''
  const selectedWorker = workers.find(worker => worker.id === effectiveWorkerId) ?? null
  const effectiveAgentKey = catalog?.agents.some(agent => agent.key === agentKey) ? agentKey : catalog?.agents[0]?.key ?? ''
  const entry = catalog?.agents.find(agent => agent.key === effectiveAgentKey) ?? null
  const receipt = inventory?.agents.find(item => item.workerId === effectiveWorkerId && item.agentKey === effectiveAgentKey) ?? null
  const effectiveInstallDir = installDir.trim() || defaultAgentInstallDirectory(workerHome, effectiveAgentKey)
  const candidates = useMemo(() => [serverUrl, ...extraCandidates.split(',')].map(value => value.trim()).filter(Boolean), [serverUrl, extraCandidates])
  const built = useMemo(() => buildManagedAgentInstallCommand({
    serverUrl, serverUrls: candidates, agentKey: effectiveAgentKey, installDir: effectiveInstallDir, workerHome,
    agentKeys: catalog?.agents.map(agent => agent.key), transport,
  }), [serverUrl, candidates, effectiveAgentKey, effectiveInstallDir, workerHome, catalog, transport])

  useEffect(() => {
    if (!waiting || !receipt) return
    if (receipt.distribution.state === 'distributed' || receipt.distribution.state === 'failed') setWaiting(false)
  }, [waiting, receipt])

  const submit = async () => {
    if (!selectedWorker || !entry) throw new Error('请先选择目标工作节点与 Agent。')
    const result = await api.installManagedAgent({ workerId: selectedWorker.id, agentKey: entry.key })
    setSubmitted({ ...result, at: new Date().toISOString() })
    setWaiting(true)
    changed.current()
    return `已提交托管安装请求：${result.packageName}@${result.packageVersion}（绑定 ${result.binding.status}）。只有 Worker 回执才能确认是否安装成功。`
  }

  return <section className="account-section" aria-label="托管 Agent 安装">
    <h2>托管安装 Agent</h2>
    <p>托管安装使用 Server 与 Worker 共用的固定版本清单，安装到 Worker home 内的独立目录，不写全局 npm 前缀。提交只创建托管修订与分发绑定；Worker 校验 sha512、探测版本并回执后才算装上，重新选择路径需要重启 Worker。</p>
    {!catalog && !catalogError && <p role="status">正在加载固定版本清单…</p>}
    {catalogError && <><p role="alert">{catalogError}</p><Button variant="outline" onClick={() => setRevision(value => value + 1)}>重试加载固定版本清单</Button></>}
    {catalog && <>
      <p>固定版本：{catalog.agents.map(agent => `${agent.key}@${agent.packageVersion}`).join('、')}。注册源：{catalog.registryOrigin}。脚本：{catalog.installerPath}｜清单：{catalog.manifestPath}。</p>
      <div className="account-actions">
        <label>目标工作节点<select aria-label="托管安装目标工作节点" value={effectiveWorkerId} disabled={workers.length === 0} onChange={event => { setWorkerId(event.target.value); setSubmitted(null); setWaiting(false) }}>
          {workers.length === 0 && <option value="">资源清单尚未加载</option>}
          {workers.map(worker => <option key={worker.id} value={worker.id}>{worker.name}（{worker.connectionState}）</option>)}
        </select></label>
        <label>Agent<select aria-label="托管安装 Agent" value={effectiveAgentKey} onChange={event => { setAgentKey(event.target.value); setSubmitted(null); setWaiting(false) }}>
          {catalog.agents.map(agent => <option key={agent.key} value={agent.key}>{agent.key}（{agent.packageName}@{agent.packageVersion}）</option>)}
        </select></label>
      </div>

      <section aria-label="在线托管下发">
        <h3>在线节点：由集群下发</h3>
        {!selectedWorker ? <p role="status">资源清单还没有可用的工作节点，无法选择在线下发；离线或自托管节点仍可使用下方一键命令。</p>
          : selectedWorker.connectionState === 'revoked' ? <p role="alert">{selectedWorker.name} 已被吊销，集群不会向该节点下发执行资源。请先恢复节点，或在该机上自行执行下方命令。</p>
            : selectedWorker.connectionState === 'online' ? <>
              <p>{selectedWorker.name} 在线。确认后集群下发 {entry?.packageName}@{entry?.packageVersion} 的托管修订（绑定目标：Worker home 内的独立目录，不覆盖全局安装）。</p>
              <ConfirmButton confirm={`确认让 ${selectedWorker.name} 托管安装 ${effectiveAgentKey}@${entry?.packageVersion ?? ''}？安装到该节点 Worker home 内的独立目录，不覆盖全局安装。`} act={submit} disabled={!entry}>托管安装</ConfirmButton>
            </> : <p role="status">{selectedWorker.name} 当前不在线，集群无法推送托管修订。请在该节点上执行下方一键命令，或等它上线后再提交。</p>}
      </section>

      <section aria-label="托管安装回执">
        <h3>该节点上的 Agent 状态</h3>
        {!receipt ? <p role="status">还没有该工作节点与 Agent 的探测或分发记录。</p> : <>
          <p>{receipt.name}{receipt.version ? `｜探测版本 ${receipt.version}` : ''}</p>
          <dl>
            <ReceiptAxis label={axisTitles.configuration} state={configurationLabels[receipt.configuration.state]} detail={receipt.configuration.detail} observedAt={receipt.configuration.observedAt} />
            <ReceiptAxis label={axisTitles.distribution} state={distributionLabels[receipt.distribution.state]} detail={receipt.distribution.detail} observedAt={receipt.distribution.observedAt} />
            <ReceiptAxis label={axisTitles.execution} state={executionLabels[receipt.execution.state]} detail={receipt.execution.detail} observedAt={receipt.execution.observedAt} />
          </dl>
        </>}
        {submitted && <p role="status">已在 {new Date(submitted.at).toLocaleTimeString('zh-CN')} 提交 {submitted.packageName}@{submitted.packageVersion}（绑定 {submitted.binding.status}，期望态修订 v{submitted.binding.revision}）。</p>}
        {waiting && <p role="status">正在等待 Worker 回执…可随时用上方「刷新资源清单」查看最新状态。</p>}
      </section>

      <section aria-label="离线与自托管一键命令">
        <h3>离线/自托管：一键命令</h3>
        <p>展示命令不等于已安装。命令在目标机器上执行：从本 Server 下载安装脚本，校验 sha512 后安装到指定目录，并把托管选择写入该机的 Worker home。安装目录必须是绝对路径且位于 Worker home 内（{catalog.installDirectoryRule}）。</p>
        <div className="account-actions">
          <label>Server 地址<Input aria-label="安装服务器地址" value={serverUrl} onChange={event => setServerUrl(event.target.value)} /></label>
          <label>候选地址（逗号分隔，可选）<Input aria-label="候选服务器地址" value={extraCandidates} placeholder="http://100.101.102.103:8010,http://192.168.1.10:8010" onChange={event => setExtraCandidates(event.target.value)} /></label>
          <label>Worker home<Input aria-label="Worker home 目录" value={workerHome} onChange={event => setWorkerHome(event.target.value)} /></label>
          <label>安装目录（留空用缺省）<Input aria-label="Agent 安装目录" value={installDir} placeholder={defaultAgentInstallDirectory(workerHome, effectiveAgentKey)} onChange={event => setInstallDir(event.target.value)} /></label>
          <label>脚本下载方式<select aria-label="脚本下载传输方式" value={transport} onChange={event => setTransport(event.target.value === 'nc' ? 'nc' : 'direct')}>
            <option value="direct">直连（curl）</option>
            <option value="nc">nc 隧道（无 curl，经 tailscale nc）</option>
          </select></label>
        </div>
        {built.issues.length > 0 ? <p role="alert">当前输入无法生成命令：{built.issues.map(issue => issue.message).join(' ')}</p> : <>
          <pre ref={command} className="machine" tabIndex={0} aria-label="一键安装命令">{built.command}</pre>
          <Button variant="outline" onClick={async () => {
            if (await copyText(built.command)) { setCopyNotice('已复制一键安装命令。'); return }
            if (command.current) selectElementText(command.current)
            setCopyNotice('无法自动复制（非安全上下文），已选中命令，请按 Ctrl+C 或长按复制。')
          }}><Copy aria-hidden />复制一键命令</Button>
          <p role="status">{copyNotice}</p>
        </>}
        <p>重启提示：{catalog.restartNotice}</p>
      </section>
    </>}
  </section>
}

function ReceiptAxis({ label, state, detail, observedAt }: { label: string; state: string; detail: string; observedAt: string | null }) {
  return <div>
    <dt>{label}</dt>
    <dd>{state}｜{detail}｜{observation(observedAt)}</dd>
  </div>
}
