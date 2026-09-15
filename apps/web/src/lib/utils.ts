import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Copy text to the clipboard. Returns false when the browser cannot do it.
 *
 * Insecure plain-HTTP origins (LAN / Tailscale IPs): navigator.clipboard is
 * absent and modern Chromium silently ignores execCommand('copy')
 * while still returning true — claiming success would lie to the user, so we
 * return false and let callers fall back to select-for-manual-copy.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!(navigator.clipboard && window.isSecureContext)) return false
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

/** Select an element's text so the user can copy it natively (Ctrl+C / long-press) — works even on insecure origins. */
export function selectElementText(element: HTMLElement): void {
  const selection = document.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
}
