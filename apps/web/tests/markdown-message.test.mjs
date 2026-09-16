import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { MarkdownMessage, messageUrl } from '../src/components/markdown-message.ts'

const render = text => renderToStaticMarkup(createElement(MarkdownMessage, { text }))
test('message renders headings, lists, emphasis, quotes, fenced code and GFM', () => {
  const html = render('# 标题\n\n**重点** 和 *强调*、~~删除~~、`代码`\n\n- 项目\n\n1. 步骤\n\n> 引用\n\n```js\nconst x = "<script>"\n```\n\n| 名称 | 状态 |\n| --- | --- |\n| 会话 | 就绪 |\n\n- [x] 完成\n- [ ] 待做')
  for (const tag of ['h1', 'strong', 'em', 'del', 'ul', 'ol', 'blockquote', 'table', 'th', 'td']) assert.match(html, new RegExp(`<${tag}[ >]`))
  assert.match(html, /class="language-js"/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /aria-label="代码块"/)
  assert.match(html, /aria-label="表格"/)
  assert.match(html, /type="checkbox" disabled="" checked=""/)
})
test('untrusted HTML and unsafe URLs never become executable elements or links', () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://evil.test"></iframe>\n\n[bad](javascript:alert%281%29) [data](data:text/html,evil) [relative](/api/logout) [good](https://example.com)')
  assert.doesNotMatch(html, /<(script|img|iframe)\b|href="(?:javascript:|data:|\/api)/)
  assert.match(html, /href="https:\/\/example.com\/"/)
  assert.match(html, /rel="noopener noreferrer"/)
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/a', '/api/session', '//evil.test', 'vbscript:test']) assert.equal(messageUrl(url), '')
})
test('images are explicit links, never automatic remote requests', () => {
  const html = render('![结果](https://example.com/tracker.png)')
  assert.doesNotMatch(html, /<img\b/)
  assert.match(html, /图片：结果/)
  assert.match(html, /referrerPolicy="no-referrer"/i)
})
test('incomplete streaming Markdown stays renderable until its final delimiters arrive', () => {
  const text = '## 回复\n\n**正在输出**\n\n```ts\nconsole.log("你好")\n```'
  for (let i = 1; i <= text.length; i++) assert.doesNotThrow(() => render(text.slice(0, i)))
  assert.match(render(text), /language-ts/)
})
test('confirmed and optimistic messages use Markdown, tools remain literal output', () => {
  const source = readFileSync(new URL('../src/features/sessions/conversation.tsx', import.meta.url), 'utf8')
  assert.match(source, /<MarkdownMessage text=\{entry.text\}/)
  assert.match(source, /<MarkdownMessage text=\{item.content\}/)
  assert.match(source, /\{entry.output\}<\/pre>/)
})
