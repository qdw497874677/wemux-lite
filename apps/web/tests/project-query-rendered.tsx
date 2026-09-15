import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useProject } from '../src/app/use-project'

const callbacks: { event: (event: unknown) => void; state: (state: string) => void }[] = []
let stops = 0, calls = 0, rows: any[] = [], reject = false
const api: any = {
  watchProject(_p: string, event: any, state: any) { callbacks.push({ event, state }); return () => { stops++ } },
  tasks: async () => { calls++; if (reject) throw Error('server unavailable'); return [{ title: `generation-${calls}` }] },
  workspaces: async () => [], sessions: async () => [], pendingReviews: async () => [],
  projectActivity: async (_p: string, cursor: number) => { if (reject) throw Error('server unavailable'); return rows.filter(row => row.cursor > cursor).slice(0, 2) },
}
function View({ project }: { project: string }) {
  const data = useProject(api, project)
  return <div><p id="title">{data.tasks.data?.[0]?.title}</p><p id="stream">{data.stream}</p><p id="history">{data.activity.data?.map(row => row.cursor).join(',')}</p><p id="error">{data.activity.error?.message}</p></div>
}
let client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
const root = createRoot(document.getElementById('root')!)
const render = (project: string) => root.render(<QueryClientProvider client={client}><View key={project} project={project} /></QueryClientProvider>)
Object.assign(window, { harness: {
  render, callbacks, stats: () => ({ calls, stops }),
  append: (cursor: number) => rows.push({ cursor, activity: { taskId: 't', seq: cursor, type: 'task.updated' } }),
  reject: (value: boolean) => { reject = value },
  auth: () => { root.render(null); client.clear(); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
  unmount: () => root.unmount(),
} })
render('p')
