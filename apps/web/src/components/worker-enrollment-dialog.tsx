import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Clipboard, LoaderCircle, Network, RotateCcw, Server, ShieldCheck, Terminal } from 'lucide-react'
import type { Api } from '@/api/client'
import type { EnrollmentTokenDTO, TailnetInfoDTO, WorkerDTO } from '@/api/dto'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { buildWorkerInstallCommand } from '@/lib/worker-install'
import { copyText, selectElementText } from '@/lib/utils'

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '请求失败'
const defaultServerUrl = () => {
  const url = new URL(window.location.origin)
  if (url.port === '8002') url.port = '3001'
  return url.toString().replace(/\/$/, '')
}

export function WorkerEnrollmentDialog({ api, workers, onRefreshWorkers, onClose }: { api: Api; workers: WorkerDTO[]; onRefreshWorkers: () => void; onClose: () => void }) {
  const initialWorkerIds = useRef<Set<string> | null>(null)
  const [name, setName] = useState('工作节点 01')
  const [ttlSeconds, setTtlSeconds] = useState('3600')
  const [serverUrl, setServerUrl] = useState(defaultServerUrl)
  const [enrollment, setEnrollment] = useState<EnrollmentTokenDTO | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [manualMode, setManualMode] = useState(false)
  const commandRef = useRef<HTMLPreElement | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [tailnet, setTailnet] = useState<TailnetInfoDTO | null>(null)
  const [prefer, setPrefer] = useState<'auto' | 'tailnet' | 'direct'>('auto')
  const [transport, setTransport] = useState<'direct' | 'nc'>('direct')
  const registered = workers.find(worker => initialWorkerIds.current !== null && !initialWorkerIds.current.has(worker.id))
  const expired = enrollment ? Date.parse(enrollment.expiresAt) <= now : false
  const plainHttp = (() => { try { const url = new URL(serverUrl.trim()); return url.protocol === 'http:' } catch { return false } })()
  // 服务端自检 Tailscale：管理员不必知道 tailnet 地址，弹窗直接推荐
  useEffect(() => { void api.tailnet().then(setTailnet).catch(() => setTailnet(null)) }, [api])
  const tailnetHost = tailnet?.available === true && tailnet.state === 'Running' ? (tailnet.dnsName ?? tailnet.selfIps.find(ip => ip.includes('.')) ?? null) : null
  // 候选地址 = 输入地址 + tailnet 地址 + 服务端全部局域网 IP（同端口），去重；
// 单地址失败无从切换，多候选才能让 worker 自动轮换（下载、注册、WebSocket 三段都用它）
  const candidateUrls = useMemo(() => {
    const primary = serverUrl.trim()
    let port = ''
    try { port = new URL(primary).port || window.location.port } catch { /* 输入未完成时忽略 */ }
    const suffix = (host: string) => `http://${host.includes(':') ? `[${host}]` : host}${port ? `:${port}` : ''}`
    const extras = [...(tailnet?.selfIps ?? []), ...(tailnet?.lanIps ?? [])].filter(Boolean).map(suffix)
    if (tailnetHost) extras.push(suffix(tailnetHost))
    const seen = new Set<string>()
    return [primary, ...extras].filter(url => { if (seen.has(url)) return false; seen.add(url); return true })
  }, [serverUrl, tailnet, tailnetHost])
  const httpCandidates = useMemo(() => candidateUrls.filter(url => url.startsWith('http://')), [candidateUrls])
  const command = useMemo(() => enrollment ? buildWorkerInstallCommand({ token: enrollment.token, serverUrl: serverUrl.trim(), workerName: name.trim(), serverUrls: candidateUrls.length > 1 ? candidateUrls : undefined, prefer: prefer === 'auto' ? 'any' : prefer, transport }) : '', [enrollment, name, serverUrl, candidateUrls, prefer, transport])

  useEffect(() => {
    if (!enrollment || registered) return
    onRefreshWorkers()
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { window.clearInterval(clock) }
  }, [enrollment, onRefreshWorkers, registered])

  async function generate() {
    if (busy || !name.trim() || !serverUrl.trim()) return
    setBusy(true); setError(''); setCopied(false)
    try {
      const url = new URL(serverUrl.trim())
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('服务端地址必须使用 http:// 或 https://。')
      setServerUrl(url.toString().replace(/\/$/, ''))
      initialWorkerIds.current = new Set(workers.map(worker => worker.id))
      const result = await api.createEnrollmentToken({ ttlSeconds: Number(ttlSeconds) })
      setEnrollment(result); setNow(Date.now())
    } catch (cause) { setError(errorText(cause)) }
    finally { setBusy(false) }
  }

  async function copy() {
    if (await copyText(command)) { setCopied(true); window.setTimeout(() => setCopied(false), 2000) }
    else {
      // HTTP 明文访问时浏览器禁止自动写剪贴板（Chromium 连 execCommand 都静默拒绝）：
      // 全选命令并引导手动 Ctrl+C / 长按复制，这是原生行为，不受限制。
      setManualMode(true)
      if (commandRef.current) { selectElementText(commandRef.current); commandRef.current.focus({ preventScroll: true }) }
    }
  }

  function selectCommandManually() {
    setManualMode(true)
    if (commandRef.current) { selectElementText(commandRef.current); commandRef.current.focus({ preventScroll: true }) }
  }

  function reset() { setEnrollment(null); setCopied(false); setManualMode(false); setError(''); initialWorkerIds.current = null }

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>添加工作节点</DialogTitle><DialogDescription>生成一条安装命令，在目标机器执行后即可接入。</DialogDescription></DialogHeader>
    {!enrollment ? <form className="space-y-4" onSubmit={event => { event.preventDefault(); void generate() }}>
      <div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-2 text-xs">工作节点名称<Input autoFocus value={name} maxLength={200} onChange={event => setName(event.target.value)} placeholder="例如：办公室 Mac mini" /></label><label className="grid gap-2 text-xs">安装命令有效期<Select value={ttlSeconds} onValueChange={setTtlSeconds}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="300">5 分钟</SelectItem><SelectItem value="900">15 分钟</SelectItem><SelectItem value="3600">1 小时（推荐）</SelectItem><SelectItem value="86400">24 小时</SelectItem></SelectContent></Select></label></div>
      <label className="grid gap-2 text-xs">工作节点可访问的服务端地址<Input value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="https://wemux.example.com、http://192.168.1.10:3001 或 Tailscale http://100.101.102.103:8010" /></label>
      <div className="grid gap-4 sm:grid-cols-2"><div className="grid gap-2 text-xs"><span className="font-medium">工作节点连接方式</span><Select value={prefer} onValueChange={value => setPrefer(value as 'auto' | 'tailnet' | 'direct')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">自动（默认，失败自动切换）</SelectItem><SelectItem value="tailnet">优先 Tailscale（故障时切直连）</SelectItem><SelectItem value="direct">优先直连（故障时切 Tailscale）</SelectItem></SelectContent></Select><p className="text-xs leading-relaxed text-muted-foreground">多候选地址时，工作节点会记住全部地址并按这里的选择排序重试；单地址环境下始终直连。</p></div><div className="grid gap-2 text-xs"><span className="font-medium">传输通道</span><Select value={transport} onValueChange={value => setTransport(value as 'direct' | 'nc')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="direct">直连（默认，curl + WebSocket）</SelectItem><SelectItem value="nc" disabled={httpCandidates.length === 0}>tailscale nc 隧道（无需路由）</SelectItem></SelectContent></Select><p className="text-xs leading-relaxed text-muted-foreground">{transport === 'nc' ? '下载、注册与 WebSocket 全部经 tailscale nc 隧道转发，适合目标机与服务端无直接路由、仅 tailnet 互通的场景；需要 node 与 tailscale CLI，仅支持 http 地址。' : '目标机能路由到服务端地址时选直连；nc 模式下全部流量经 tailscale 隧道，不要求直连路由。'}</p></div></div>
      {candidateUrls.length > 1 && <p className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-xs leading-5 text-primary"><Network className="size-3.5 shrink-0" />已为服务端检测到 {candidateUrls.length} 个可达地址（Tailscale / 局域网），全部已写入安装命令：下载、注册、WebSocket 任一环节失败都会自动切换下一个。</p>}
      <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-5 text-amber-100">如果当前页面通过 <code>localhost</code> 或 <code>127.0.0.1</code> 打开，远程工作节点无法使用这个默认地址。请填写服务端的局域网 IP 或 HTTPS 域名。</p>
      {plainHttp && <p className="rounded-lg border border-amber-500/40 bg-amber-500/15 p-3 text-xs leading-5 text-amber-100">当前使用 HTTP：安装令牌与后续通信将明文传输，仅建议在可信内网使用；公网部署请改用 HTTPS。</p>}
      {error && <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !name.trim() || !serverUrl.trim()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}{busy ? '正在生成…' : '生成安装命令'}</Button></div>
    </form> : <div className="space-y-4">
      {registered ? <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4"><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-full bg-emerald-500/20 text-emerald-300"><Check className="size-5" /></span><div><h3 className="text-sm font-semibold text-emerald-100">工作节点已注册</h3><p className="mt-1 text-xs text-emerald-200">{registered.name} · {registered.connectionState === 'online' ? '已在线' : '已注册，等待建立连接'}</p></div></div></section> : <section className="rounded-xl border border-primary/25 bg-primary/10 p-4"><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/15 text-primary"><Server className="size-4" /></span><div className="min-w-0"><h3 className="text-sm font-semibold">等待工作节点接入</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">在目标机器执行下方命令。页面通过共享资源查询检查新的工作节点。</p><p className={`mt-1 text-xs ${expired ? 'text-red-300' : 'text-amber-200'}`}>{expired ? '安装命令已失效，请重新生成。' : `安装命令有效至：${new Date(enrollment.expiresAt).toLocaleString('zh-CN')}`}</p></div></div></section>}
      <div className="space-y-2"><div className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-xs font-medium"><Terminal className="size-4" />安装、注册并启动</span><Button size="sm" variant="outline" disabled={expired || registered !== undefined} onClick={() => { void copy() }}>{copied ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}{copied ? '已复制' : manualMode ? '已全选，请 Ctrl+C / 长按复制' : '复制命令'}</Button></div>{manualMode && <p className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-200">当前为 HTTP 明文访问，浏览器禁止网页自动写剪贴板。已为你全选命令，请按 Ctrl+C（手机长按 → 拷贝）完成复制；配置 HTTPS 后可恢复一键复制。</p>}<pre ref={commandRef} tabIndex={-1} onClick={selectCommandManually} className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-border bg-black/40 p-4 text-[11px] leading-5 text-slate-200"><code>{command}</code></pre>{manualMode && <p className="text-xs text-muted-foreground">提示：点击命令区域可重新全选。</p>}</div>
      <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground"><p className="font-medium text-foreground">目标机器需要：</p><ul className="list-disc space-y-1 pl-5"><li>Linux、macOS 或 WSL</li><li>{transport === 'nc' ? <>Node.js 22+、npm 与 tailscale CLI（命令经隧道下载，无需 curl）</> : <>curl、Node.js 22+ 和 npm</>}</li><li>{transport === 'nc' ? <><code className="font-mono">tailscale status</code> 在目标机上正常返回，且已加入与服务端相同的 tailnet（不要求直连路由）</> : '能够访问上面填写的服务端地址'}</li></ul><p>命令会从当前服务端下载安装包并启动工作节点。一次性安装令牌不会进入下载地址；请勿把完整命令发送到聊天、工单或日志中。</p></div>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between"><Button variant="ghost" disabled={busy} onClick={reset}><RotateCcw className="size-4" />{expired ? '重新生成命令' : '生成另一条命令'}</Button><Button onClick={onClose}>{registered ? '完成' : '稍后完成'}</Button></div>
    </div>}
  </DialogContent></Dialog>
}
