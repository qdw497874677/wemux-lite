import { Component, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { errorPresentation, type Presentation } from '../application.ts'
import { Button } from './primitives.tsx'

export function Failure({ error, retry }: { error: Presentation; retry?: () => void }) {
  return <section role="alert" className="failure"><AlertTriangle aria-hidden /><div><h2>{error.title}</h2><p>{error.message}</p>{retry && <Button variant="outline" onClick={retry}>重试</Button>}</div></section>
}
export class RenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    return this.state.failed ? <main className="recovery"><Failure error={errorPresentation(Error('render'))} /><Button onClick={() => window.location.reload()}>重新加载页面</Button><a href="/next/projects">返回项目列表</a><a href="/">返回旧版控制台</a></main> : this.props.children
  }
}
