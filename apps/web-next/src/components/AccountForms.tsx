import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input } from './primitives.tsx'

export const accountError = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^请求失败（HTTP \d+）：/, '') : '请求失败，请重试。'
export type Field = { name: string; label: string; type?: string; required?: boolean; value?: string; minLength?: number }
/** Unmount retires UI updates; the identity transport separately cancels requests. */
export function useAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const pending = useRef(false)
  async function run(work: () => Promise<string | void>) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try { const result = await work(); if (alive.current) setNotice(result || '') }
    catch (cause) { if (alive.current) setError(accountError(cause)) }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  return { busy, run, feedback: <>{busy && <p role="status">正在处理…</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</> }
}
export function AccountSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="account-section"><h2>{title}</h2>{children}</section>
}
export function ActionForm({ label, fields = [], submit, children, disabled = false, confirm }: { label: string; fields?: Field[]; submit: (values: Record<string, string>) => Promise<string | void>; children?: ReactNode; disabled?: boolean; confirm?: string }) {
  const action = useAction()
  return <form className="account-form" onSubmit={event => {
    event.preventDefault(); const form = event.currentTarget
    if (confirm && !window.confirm(confirm)) return
    const values = Object.fromEntries(new FormData(form)) as Record<string, string>
    void action.run(async () => { const notice = await submit(values); form.reset(); return notice })
  }}><fieldset disabled={disabled || action.busy}>{fields.map(field => <label key={field.name}>{field.label}<Input name={field.name} type={field.type ?? 'text'} required={field.required ?? true} defaultValue={field.value} minLength={field.minLength} autoComplete={field.type === 'password' ? (field.name === 'currentPassword' ? 'current-password' : 'new-password') : undefined} /></label>)}{children}<Button type="submit">{label}</Button></fieldset>{action.feedback}</form>
}
export function ConfirmButton({ children, confirm, act, disabled }: { children: ReactNode; confirm: string; act: () => Promise<string | void>; disabled?: boolean }) {
  const action = useAction()
  return <div><Button variant="outline" disabled={disabled || action.busy} onClick={() => { if (window.confirm(confirm)) void action.run(act) }}>{children}</Button>{action.feedback}</div>
}
export function useAccountData<T>(load: () => Promise<T>, dependencies: unknown[]) {
  const [data, setData] = useState<T>(), [error, setError] = useState(''), [revision, setRevision] = useState(0), [settledRevision, setSettledRevision] = useState(-1), [loading, setLoading] = useState(true)
  useEffect(() => { setData(undefined); setError('') }, dependencies)
  useEffect(() => {
    let active = true; setError(''); setLoading(true)
    void load().then(value => { if (active) { setData(value); setSettledRevision(revision); setLoading(false) } }).catch(cause => { if (active) { setData(undefined); setError(accountError(cause)); setLoading(false) } })
    return () => { active = false }
    // The caller supplies the identity and scope dependencies explicitly.
  }, [...dependencies, revision])
  return { data, loading, ready: settledRevision === revision && !loading && data !== undefined, reload: () => setRevision(value => value + 1), feedback: error ? <div role="alert">{error}<Button variant="outline" onClick={() => setRevision(value => value + 1)}>重试</Button></div> : !data ? <p role="status">正在加载…</p> : null }
}
