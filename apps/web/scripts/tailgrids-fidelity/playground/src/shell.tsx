import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { specs, specById, type Spec, type Kit } from './specimens'
import { mapping } from './kits/mapping'

const STAGE_WIDTH = 960

/** 受控画布：dark 用上游 background-100(#111827)，light 用白 */
const CANVAS: Record<string, string> = { dark: '#111827', light: '#ffffff' }

// 画布与字体是受控变量，不属于被测组件：
// - 页面底色/默认文字色两侧写死同一个常量，避免 token 语义差异污染组件比对；
// - 字体强制同一套本机字体，避免把 webfont 差异算进组件保真度。
const stageStyle: React.CSSProperties = {
  width: STAGE_WIDTH,
  margin: '0 auto',
  padding: 24,
  display: 'grid',
  gap: 24,
  fontFamily: '"DejaVu Sans", "Liberation Sans", Arial, sans-serif',
}

function SpecFrame({ spec, kit, mode }: { spec: Spec; kit: Kit; mode: 'inline' | 'only' }) {
  return (
    <section
      data-fidelity={spec.id}
      data-spec-group={spec.group}
      style={{ display: 'grid', gap: 8, marginTop: mode === 'only' ? (spec.headroom ?? 0) : 0 }}
    >
      <div style={{ fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', opacity: 0.55 }}>{spec.name}</div>
      <div data-fidelity-body>{spec.render(kit, mode)}</div>
    </section>
  )
}

export function FidelityPage({ kit }: { kit: Kit }) {
  useEffect(() => {
    const scheme = new URLSearchParams(location.search).get('scheme') === 'light' ? 'light' : 'dark'
    document.documentElement.lang = 'zh'
    // 内联样式优先级最高：压过各自主题里的 html/body 规则，两侧画布完全一致。
    document.documentElement.style.colorScheme = scheme
    document.documentElement.style.background = CANVAS[scheme]
    document.body.style.margin = '0'
    document.body.style.background = CANVAS[scheme]
    document.body.style.color = scheme === 'dark' ? '#ffffff' : '#111827'
  }, [])

  const only = new URLSearchParams(location.search).get('only')
  const spec = only ? specById(only) : undefined
  if (only && !spec) throw new Error(`未知样本: ${only}`)

  const body = spec ? (
    <SpecFrame spec={spec} kit={kit} mode="only" />
  ) : (
    specs.filter((s) => !s.overlay).map((s) => <SpecFrame key={s.id} spec={s} kit={kit} mode="inline" />)
  )

  return (
    <>
      <div data-kit={kit.id} data-kit-label={kit.label} hidden />
      <div data-spec-index hidden>{JSON.stringify(specs.map((s) => ({ id: s.id, name: s.name, group: s.group, overlay: !!s.overlay, clip: s.clip, panel: s.panel, deviations: s.deviations ?? [] })))}</div>
      {kit.id === 'ours' ? <div data-kit-mapping hidden>{JSON.stringify(mapping)}</div> : null}
      <main style={stageStyle} data-stage>
        {body}
        <div data-ready="1" style={{ height: 0 }} aria-hidden="true" />
      </main>
    </>
  )
}

export function mount(kit: Kit) {
  createRoot(document.getElementById('root')!).render(<FidelityPage kit={kit} />)
}

export { STAGE_WIDTH }