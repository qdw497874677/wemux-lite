import { Children, createElement, Fragment, isValidElement, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { copyText, selectElementText } from '../lib/utils.ts'
import { HIGHLIGHT_LINE_LIMIT, normalizeSyntaxLanguage, prepareSyntaxHighlight, truncateHighlightCode, type HighlightedLine, type SyntaxTheme } from '../lib/syntax-highlighting.ts'

export type SyntaxBlockProps = { code: string; language?: string; partial?: boolean }

function currentTheme(): SyntaxTheme {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) return 'dark'
  if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
  return 'light'
}

function tokenStyle(token: HighlightedLine[number]): CSSProperties | undefined {
  const fontStyle = token.fontStyle ?? 0
  if (!token.color && !fontStyle) return undefined
  return {
    ...(token.color ? { color: token.color } : {}),
    ...(fontStyle & 1 ? { fontStyle: 'italic' } : {}),
    ...(fontStyle & 2 ? { fontWeight: 700 } : {}),
    ...(fontStyle & 4 ? { textDecoration: 'underline' } : {}),
  }
}

function HighlightedCode({ lines }: { lines: HighlightedLine[] }) {
  return createElement(Fragment, null, ...lines.map((line, lineIndex) => createElement('span', { className: 'syntax-line', key: lineIndex },
    ...line.map((token, tokenIndex) => createElement('span', { key: tokenIndex, style: tokenStyle(token) }, token.content)),
    lineIndex < lines.length - 1 ? '\n' : null)))
}

export function SyntaxBlock({ code, language, partial = false }: SyntaxBlockProps) {
  const normalizedLanguage = normalizeSyntaxLanguage(language)
  const truncated = useMemo(() => truncateHighlightCode(code), [code])
  const [highlighted, setHighlighted] = useState<HighlightedLine[] | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const [codeContainer, setCodeContainer] = useState<HTMLPreElement | null>(null)
  const theme = currentTheme()

  useEffect(() => {
    let active = true
    setHighlighted(null)
    if (!partial && normalizedLanguage) void prepareSyntaxHighlight(code, normalizedLanguage, partial, theme).then(result => {
      if (active) setHighlighted(result.highlighted)
    })
    return () => { active = false }
  }, [code, normalizedLanguage, partial, theme])

  const copy = async () => {
    if (await copyText(code)) {
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1600)
      return
    }
    if (codeContainer) selectElementText(codeContainer)
    setCopyState('manual')
  }

  const label = language?.trim() || 'text'
  const unhighlightedRemainder = truncated.omittedLines > 0 ? code.split('\n').slice(HIGHLIGHT_LINE_LIMIT).join('\n') : ''
  const renderedCode = highlighted
    ? createElement(Fragment, null, createElement(HighlightedCode, { lines: highlighted }), unhighlightedRemainder ? `\n${unhighlightedRemainder}` : null)
    : code
  const copyTitle = copyState === 'manual' ? '请按 Ctrl+C / 长按复制' : copyState === 'copied' ? '已复制' : '复制代码'
  return createElement('div', { className: 'syntax-block', 'data-language': label, 'data-highlighted': highlighted ? 'true' : 'false' },
    createElement('div', { className: 'syntax-block-header' },
      createElement('span', { className: 'syntax-block-language' }, label),
      createElement('div', { className: 'syntax-block-actions', role: 'toolbar', 'aria-label': '代码块操作' },
        createElement('button', { type: 'button', className: 'syntax-block-copy', onClick: () => void copy(), 'aria-label': '复制代码', title: copyTitle }, createElement(copyState === 'copied' ? Check : Copy, { className: 'size-3.5', 'aria-hidden': true })),
        copyState === 'manual' ? createElement('span', { role: 'status', className: 'text-xs text-muted-foreground' }, '请按 Ctrl+C / 长按复制') : null)),
    createElement('pre', { ref: setCodeContainer, tabIndex: 0, 'aria-label': '代码块' }, createElement('code', { className: language ? `language-${language}` : undefined }, renderedCode)),
    truncated.omittedLines > 0 ? createElement('p', { className: 'syntax-block-truncated', role: 'note' }, `代码过长，仅高亮前 ${HIGHLIGHT_LINE_LIMIT} 行；其余 ${truncated.omittedLines} 行以纯文本显示。`) : null)
}

export function syntaxBlockFromPre(children: ReactNode, partial: boolean): ReactNode {
  const nodes = Children.toArray(children)
  const child = nodes.length === 1 ? nodes[0] : null
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return createElement('pre', { tabIndex: 0, 'aria-label': '代码块' }, children)
  const language = /(?:^|\s)language-([^\s]+)/.exec(child.props.className ?? '')?.[1]
  const code = String(child.props.children ?? '').replace(/\n$/, '')
  return createElement(SyntaxBlock, { code, language, partial })
}
