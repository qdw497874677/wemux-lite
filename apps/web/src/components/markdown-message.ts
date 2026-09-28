import { createElement, memo, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { syntaxBlockFromPre } from './syntax-block.ts'

/** Message URLs are untrusted. Relative paths must not navigate the control plane. */
export function messageUrl(url: string, key?: string): string {
  if (key === 'src' && /^uploads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(url) && !url.split('/').includes('..')) return url
  try {
    const parsed = new URL(url)
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol) ? parsed.href : ''
  } catch { return '' }
}

function WorkspaceMessageImage({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false)
  const closeOnEscape = (event: { key: string }) => { if (event.key === 'Escape') setOpen(false) }
  return createElement('span', { className: 'my-2 block' },
    createElement('button', { type: 'button', className: 'block overflow-hidden rounded-xl border border-border/70 bg-muted/30', onClick: () => setOpen(true), 'aria-label': `放大图片：${alt}` },
      createElement('img', { src, alt, className: 'max-h-80 max-w-full object-contain' })),
    open ? createElement('div', { className: 'fixed inset-0 z-50 grid place-items-center bg-black/80 p-4', role: 'dialog', 'aria-modal': true, 'aria-label': alt, tabIndex: -1, onKeyDown: closeOnEscape, onClick: () => setOpen(false), ref: (node: HTMLDivElement | null) => node?.focus() },
      createElement('button', { type: 'button', className: 'absolute right-4 top-4 rounded-lg bg-black/60 px-3 py-2 text-sm text-white', onClick: () => setOpen(false), 'aria-label': '关闭图片预览' }, '关闭'),
      createElement('img', { src, alt, className: 'max-h-full max-w-full object-contain', onClick: (event: { stopPropagation: () => void }) => event.stopPropagation() })) : null)
}

const plugins = [remarkGfm]

/** Reparse growing text during streaming; never execute raw HTML from messages. */
export const MarkdownMessage = memo(function MarkdownMessage({ text, partial = false, imageSources = {} }: { text: string; partial?: boolean; imageSources?: Readonly<Record<string, string>> }) {
  const components: Components = {
    a: ({ href, children }) => href
      ? createElement('a', { href, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, children)
      : createElement('span', null, children),
    // Do not fetch arbitrary remote images (tracking pixels, private network URLs).
    img: ({ src, alt }) => src && imageSources[src]
      ? createElement(WorkspaceMessageImage, { src: imageSources[src], alt: alt || '图片' })
      : createElement('span', { className: 'text-sm text-muted-foreground' }, src ? `图片加载中：${alt || src}` : alt || '图片地址不可用'),
    pre: ({ children }) => syntaxBlockFromPre(children, partial),
    table: ({ children }) => createElement('div', { className: 'message-table-scroll', tabIndex: 0, role: 'region', 'aria-label': '表格' }, createElement('table', null, children)),
  }
  return createElement('div', { className: 'message-markdown' },
    createElement(Markdown, { remarkPlugins: plugins, skipHtml: true, urlTransform: messageUrl, components, children: text }))
})
