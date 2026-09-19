import { useCallback, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { ArrowUp, Bot, Check, Link2, LoaderCircle, RotateCcw } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

export type AiPromptStatus = 'idle' | 'loading' | 'success'

export interface AiPromptInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  modelLabel: string
  agentLabel?: string
  status?: AiPromptStatus
  disabled?: boolean
  submitDisabled?: boolean
  retry?: boolean
  placeholder?: string
  hint?: string
  error?: string
  minRows?: number
  maxRows?: number
  maxLength?: number
  className?: string
}

/**
 * Session-bound Agent composer. The model chip is intentionally read-only:
 * Wemux fixes Worker, Agent and Model when a Session is created.
 */
export function AiPromptInput({
  value,
  onChange,
  onSubmit,
  modelLabel,
  agentLabel,
  status = 'idle',
  disabled = false,
  submitDisabled = false,
  retry = false,
  placeholder = '给 Agent 发送消息…',
  hint,
  error,
  minRows = 1,
  maxRows = 8,
  maxLength = 16_000,
  className,
}: AiPromptInputProps) {
  const textarea = useRef<HTMLTextAreaElement>(null)

  const resize = useCallback(() => {
    const element = textarea.current
    if (!element) return
    const styles = window.getComputedStyle(element)
    const lineHeight = Number.parseFloat(styles.lineHeight) || 24
    const padding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom)
    const minimum = lineHeight * minRows + padding
    const maximum = lineHeight * maxRows + padding
    element.style.height = 'auto'
    const height = Math.min(Math.max(element.scrollHeight, minimum), maximum)
    element.style.height = `${height}px`
    element.style.overflowY = element.scrollHeight > maximum ? 'auto' : 'hidden'
  }, [maxRows, minRows])

  useLayoutEffect(() => { resize() }, [resize, value])
  useLayoutEffect(() => {
    const onResize = () => resize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [resize])

  const submit = () => {
    if (!submitDisabled && status !== 'loading' && value.trim()) onSubmit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    if (!(event.ctrlKey || event.metaKey || window.matchMedia('(pointer: fine)').matches)) return
    event.preventDefault()
    submit()
  }

  const label = status === 'loading' ? '正在发送' : retry ? '重试发送' : '发送消息'

  return <div className={cn('ai-prompt-input', error && 'ai-prompt-input-error', className)} data-status={status}>
    <label className="sr-only" htmlFor="session-prompt">消息内容</label>
    <textarea
      ref={textarea}
      id="session-prompt"
      value={value}
      rows={minRows}
      maxLength={maxLength}
      disabled={disabled}
      aria-describedby="session-prompt-status"
      aria-invalid={Boolean(error) || undefined}
      placeholder={placeholder}
      onChange={event => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      className="ai-prompt-input-field"
    />
    <div className="ai-prompt-toolbar">
      <div className="ai-prompt-model" aria-label={`当前智能体与模型：${agentLabel ? `${agentLabel}，` : ''}${modelLabel}`} title="会话创建后，智能体与模型保持固定">
        <span className="ai-prompt-model-icon"><Bot aria-hidden /></span>
        <span className="min-w-0 truncate">{agentLabel && <span className="ai-prompt-agent">{agentLabel}</span>}<strong>{modelLabel}</strong></span>
        <Link2 className="ai-prompt-model-lock" aria-hidden />
      </div>
      <p id="session-prompt-status" role={error ? 'alert' : 'status'} className={cn('ai-prompt-status', error && 'ai-prompt-status-error')}>{error || hint}</p>
      <button type="button" className="ai-prompt-submit" aria-label={label} title={label} disabled={submitDisabled || status === 'loading' || !value.trim()} onClick={submit}>
        <span key={`${status}:${retry}`} className="ai-prompt-submit-icon">{status === 'loading' ? <LoaderCircle className="animate-spin" aria-hidden /> : status === 'success' ? <Check aria-hidden /> : retry ? <RotateCcw aria-hidden /> : <ArrowUp aria-hidden />}</span>
      </button>
    </div>
  </div>
}
