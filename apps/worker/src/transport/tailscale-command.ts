/** 所有 Worker Tailscale 子进程使用同一个 daemon；不依赖交互 shell 函数。 */
export function tailscaleArgs(args: string[]): string[] {
  const socket = process.env.WEMUX_TS_SOCKET
  return socket ? ['--socket', socket, ...args] : [...args]
}
