import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { RenderBoundary } from './components/Failure.tsx'
import './styles.css'

createRoot(document.getElementById('root')!).render(<RenderBoundary><App /></RenderBoundary>)
document.getElementById('boot-failure')?.setAttribute('hidden', '')
