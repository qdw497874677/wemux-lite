import { createElement, memo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Message URLs are untrusted. Relative paths must not navigate the control plane. */
export function messageUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol) ? parsed.href : ''
  } catch { return '' }
}

const components: Components = {
  a: ({ href, children }) => href
    ? createElement('a', { href, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, children)
    : createElement('span', null, children),
  // Do not fetch arbitrary remote images (tracking pixels, private network URLs).
  img: ({ src, alt }) => src
    ? createElement('a', { href: src, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, `图片：${alt || '查看图片'}`)
    : createElement('span', null, alt || '图片地址不可用'),
  pre: ({ children }) => createElement('pre', { tabIndex: 0, 'aria-label': '代码块' }, children),
  table: ({ children }) => createElement('div', { className: 'message-table-scroll', tabIndex: 0, role: 'region', 'aria-label': '表格' }, createElement('table', null, children)),
}
const plugins = [remarkGfm]

/** Reparse growing text during streaming; never execute raw HTML from messages. */
export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  return createElement('div', { className: 'message-markdown' },
    createElement(Markdown, { remarkPlugins: plugins, skipHtml: true, urlTransform: messageUrl, components, children: text }))
})
