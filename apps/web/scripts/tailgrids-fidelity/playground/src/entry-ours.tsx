import './theme-ours.css'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FidelityPage } from './shell'
import { oursKit } from './kits/ours'

createRoot(document.getElementById('root')!).render(
  <TooltipProvider delayDuration={0}>
    <FidelityPage kit={oursKit} />
  </TooltipProvider>,
)
