import { useMemo } from 'react'
import type { FileReadDTO } from '../../api/dto.ts'

const delimitedExtensions = new Set(['csv', 'tsv'])
const extension = (path: string) => path.split('.').at(-1)?.toLowerCase() ?? ''

function parseDelimited(text: string, delimiter: string, maxRows = 200, maxColumns = 50): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let index = 0; index < text.length && rows.length < maxRows; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1 }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === delimiter) { if (row.length < maxColumns) row.push(field); field = '' }
    else if (char === '\n') { if (row.length < maxColumns) row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = '' }
    else field += char
  }
  if ((field || row.length) && rows.length < maxRows) { if (row.length < maxColumns) row.push(field); rows.push(row) }
  return rows
}

function DelimitedPreview({ path, text }: { path: string; text: string }) {
  const delimiter = extension(path) === 'tsv' ? '\t' : ','
  const rows = useMemo(() => parseDelimited(text, delimiter), [delimiter, text])
  if (!rows.length) return <p className="p-4 text-sm text-muted-foreground">文件为空</p>
  return <div className="max-h-full overflow-auto"><table className="w-max min-w-full border-collapse text-xs"><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex} className={rowIndex === 0 ? 'sticky top-0 bg-muted font-medium' : 'odd:bg-muted/30'}>{row.map((cell, columnIndex) => <td key={columnIndex} className="max-w-72 truncate border border-border px-2 py-1.5" title={cell}>{cell}</td>)}</tr>)}</tbody></table></div>
}

export function FilePreview({ path, file }: { path: string; file: FileReadDTO | null }) {
  if (!path) return <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">选择文件以预览</div>
  if (!file) return <div className="grid h-full place-items-center p-6 text-sm text-muted-foreground">正在加载预览…</div>
  if (file.binary || file.content === null) return <div className="grid h-full place-items-center p-6 text-center"><div><p className="font-medium">不支持预览</p><p className="mt-1 text-xs text-muted-foreground">该文件可能是二进制格式</p></div></div>
  return <div className="flex h-full min-h-0 flex-col">
    {file.truncated && <p role="status" className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">文件超过 1MB，仅显示前 1MB</p>}
    <div className="min-h-0 flex-1">{delimitedExtensions.has(extension(path)) ? <DelimitedPreview path={path} text={file.content} /> : <div className="h-full overflow-auto bg-black/15 py-3 font-mono text-xs leading-5">{file.content.split('\n').map((line, index) => <div key={index} className="grid grid-cols-[3.5rem_1fr] px-3 hover:bg-muted/40"><span className="select-none pr-4 text-right text-muted-foreground">{index + 1}</span><span className="whitespace-pre-wrap break-words">{line || ' '}</span></div>)}</div>}</div>
  </div>
}
