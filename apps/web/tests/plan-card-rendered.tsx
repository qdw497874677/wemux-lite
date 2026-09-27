import { useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { ProposedPlan } from '../src/api/journal.ts'
import { ProposedPlanCard } from '../src/features/sessions/plan-card.tsx'

const structured: ProposedPlan = { kind: 'plan', id: 'plan-1', turnId: 'turn-1', text: '1. Inspect files\n2. Add tests', steps: ['Inspect files', 'Add tests'], status: 'pending' }
const fallback: ProposedPlan = { kind: 'plan', id: 'plan-2', turnId: 'turn-2', text: '**Keep the full Markdown plan.**', status: 'pending' }

function Harness() {
  const [result, setResult] = useState('')
  return <main>
    <ProposedPlanCard plan={structured} canAct onApprove={() => setResult('approved')} onModify={() => setResult(`modified:${structured.text}`)} />
    <ProposedPlanCard plan={fallback} canAct onApprove={() => setResult('fallback-approved')} onModify={() => setResult(`fallback-modified:${fallback.text}`)} />
    <output data-testid="result">{result}</output>
  </main>
}

createRoot(document.getElementById('root')!).render(<Harness />)
