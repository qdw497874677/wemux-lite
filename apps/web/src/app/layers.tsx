import { createContext, useContext, useEffect, useState } from 'react'

export interface RunLayers { workerId: string; journal: string }
export const RunLayerContext = createContext<(layers: RunLayers | null) => void>(() => {})
export function useBrowserOnline() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  return online
}
export function useRunLayers(workerId: string, journal: string) {
  const report = useContext(RunLayerContext)
  useEffect(() => { report({ workerId, journal }); return () => report(null) }, [report, workerId, journal])
}
export function LayerStatus({ online, server, worker, journal }: { online: boolean; server: string; worker: string; journal: string }) {
  return <span className="break-words">Browser：{online ? 'online' : 'offline'} · Server：{online ? server : 'offline'} · Worker：{worker} · Journal：{journal}</span>
}
