import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import type { Api } from '../../api/client.ts'
import { MarkdownMessage } from '../markdown-message.ts'
import { cn } from '../../lib/utils.ts'

const workspaceImagePaths = (text: string): string[] => Array.from(text.matchAll(/!\[[^\]]*\]\((uploads\/[A-Za-z0-9][A-Za-z0-9._/-]*)\)/g), match => match[1]!).filter((value, index, values) => !value.split('/').includes('..') && values.indexOf(value) === index)
const imageMimeType = (path: string): string => ({ avif: 'image/avif', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp' }[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream')

export function Response({ className, children, partial = false, api, sessionId, ...props }: ComponentProps<'div'> & { partial?: boolean; api?: Api; sessionId?: string }) {
  const text = String(children ?? '')
  const paths = useMemo(() => workspaceImagePaths(text), [text])
  const [imageSources, setImageSources] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    if (!api || !sessionId || !paths.length) { setImageSources({}); return () => { cancelled = true } }
    void Promise.all(paths.map(async path => {
      try {
        const file = await api.readSessionFile(sessionId, path, 10 * 1024 * 1024)
        return file.binary && file.base64Content && !file.truncated ? [path, `data:${imageMimeType(path)};base64,${file.base64Content}`] as const : null
      } catch { return null }
    })).then(values => { if (!cancelled) setImageSources(Object.fromEntries(values.filter(value => value !== null))) })
    return () => { cancelled = true }
  }, [api, sessionId, paths.join('\n')])
  return <div className={cn('min-w-0', className)} {...props}><MarkdownMessage text={text} partial={partial} imageSources={imageSources} /></div>
}
