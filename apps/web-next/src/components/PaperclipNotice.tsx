import license from '../PAPERCLIP-LICENSE.txt?raw'

export function PaperclipNotice() {
  return <details className="license-notice"><summary>开源许可</summary><p>部分界面与交互改编自 Paperclip，遵循 MIT 许可。</p><pre>{license}</pre></details>
}
