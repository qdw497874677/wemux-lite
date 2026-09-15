import { ncDownloadScript } from '@wemux/web-contract'
import { open } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { AppError } from '../application/errors.js'

export const workerTarballPath = '/downloads/worker.tgz'
export const workerInstallerPath = '/downloads/install-worker.sh'

const installer = `#!/bin/sh
set -eu

server_urls="${'${WEMUX_SERVER_URLS:-${WEMUX_SERVER_URL:-}}'}"
server_urls="${'${server_urls%,}'}"
if [ -z "$server_urls" ]; then
  printf '%s\n' 'WEMUX_SERVER_URL (or WEMUX_SERVER_URLS) is required' >&2
  exit 64
fi
server_url="${'${server_urls%%,*}'}"

nc_transport="${'${WEMUX_TRANSPORT:-direct}'}"
case "$server_url" in
  https://*) protocols='=https' ;;
  http://*) protocols='=http,https' ;;
  *) printf '%s\n' 'server addresses must start with http:// or https://' >&2; exit 64 ;;
esac
if [ "$nc_transport" = "nc" ] && [ "$protocols" = '=https' ]; then
  printf '%s\n' 'WEMUX_TRANSPORT=nc only supports plain http server addresses' >&2
  exit 64
fi

server_url="${'${server_url%/}'}"
# 内网/tailnet 地址不走全局 HTTP 代理：代理无法路由 100.64/10、私网段，会白白卡到超时
no_proxy_extra="localhost,127.0.0.0/8,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,100.64.0.0/10,169.254.0.0/16"
export NO_PROXY="${'${NO_PROXY:+${NO_PROXY},}'}$no_proxy_extra"
export no_proxy="${'${no_proxy:+${no_proxy},}'}$no_proxy_extra"
temporary_directory="$(mktemp -d "${'${TMPDIR:-/tmp}'}/wemux-lite-worker.XXXXXX")"
trap 'rm -rf "$temporary_directory"' EXIT
trap 'exit 1' HUP INT TERM

# 逐个候选地址下载 worker 包：首个地址不可达（代理黑洞、防火墙等）时自动切换下一个
download_ok=0
if [ "$nc_transport" = "nc" ]; then
  # nc 模式：系统没有到服务端的路由，curl 直连必然失败；下载器经 tailscale nc 隧道取包。
  if ! command -v node >/dev/null 2>&1; then printf '%s\n' 'node is required for WEMUX_TRANSPORT=nc' >&2; exit 69; fi
  if ! command -v tailscale >/dev/null 2>&1; then printf '%s\n' 'tailscale CLI is required for WEMUX_TRANSPORT=nc' >&2; exit 69; fi
  for candidate in $(printf '%s' "$server_urls" | tr ',' ' '); do
    candidate="${'${candidate%/}'}"
    case "$candidate" in http://*) ;; *) continue ;; esac
    host_port="${'${candidate#http://}'}"
    host_port="${'${host_port%%/*}'}"
    case "$host_port" in
      \\[*) host="${'${host_port%%]*}'}]"; port="${'${host_port#*]}'}"; port="${'${port#:}'}"; port="${'${port:-80}'}" ;;
      *) host="${'${host_port%%:*}'}"; port="${'${host_port##*:}'}"; if [ "$host" = "$host_port" ]; then port=80; fi ;;
    esac
    if [ -z "$host" ]; then continue; fi
    printf 'Downloading worker package via tailscale nc from %s ...\n' "$candidate" >&2
    if node -e '${ncDownloadScript}' "$host" "$port" "${workerTarballPath}" "$temporary_directory/worker.tgz"; then
      download_ok=1; server_url="$candidate"; break
    fi
  done
else
  if ! command -v curl >/dev/null 2>&1; then
    printf '%s\n' 'curl is required' >&2
    exit 69
  fi
  for candidate in $(printf '%s' "$server_urls" | tr ',' ' '); do
    candidate="${'${candidate%/}'}"
    case "$candidate" in https://*|http://*) ;; *) continue ;; esac
    printf 'Downloading worker package from %s ...\n' "$candidate" >&2
    if curl --proto '=http,https' --proto-redir '=http,https' -fsS --connect-timeout 10 \
        "$candidate${workerTarballPath}" -o "$temporary_directory/worker.tgz"; then
      download_ok=1; server_url="$candidate"; break
    fi
  done
fi
if [ "$download_ok" != 1 ]; then
  printf 'Failed to download worker.tgz from any of: %s\n' "$server_urls" >&2
  exit 69
fi
printf '%s\n' 'Download complete. Installing Worker and required dependencies (no Agent runtime will be installed) ...' >&2
npm install --global --ignore-scripts --no-audit --no-fund "$temporary_directory/worker.tgz"
printf '%s\n' 'Worker installed.' >&2

if [ -n "${'${WEMUX_ENROLLMENT_TOKEN:-}'}" ]; then
  if [ -z "${'${WEMUX_WORKER_NAME:-}'}" ]; then
    printf '%s\n' 'WEMUX_WORKER_NAME is required when WEMUX_ENROLLMENT_TOKEN is set' >&2
    exit 64
  fi
  if ! wemux-lite-worker version 2>/dev/null | grep -q '^wemux-lite-worker '; then
    printf 'wemux-lite-worker is missing or shadowed by another program (resolved to %s). Uninstall the conflicting package or fix PATH, then re-run.\n' "${'$(command -v wemux-lite-worker || echo not-found)'}" >&2
    exit 70
  fi
  transport_args=""
  if [ "$nc_transport" = "nc" ]; then transport_args="--transport nc"; fi
  printf '%s\n' 'Registering Worker with Server ...' >&2
  wemux-lite-worker register --server "$server_url" --servers "$server_urls" --name "${'${WEMUX_WORKER_NAME}'}" $transport_args
  printf '%s\n' 'Starting Worker (foreground; keep this terminal open) ...' >&2
  wemux-lite-worker start $transport_args
else
  printf '%s\n' 'Wemux Worker installed. Re-run with WEMUX_ENROLLMENT_TOKEN and WEMUX_WORKER_NAME to register this machine, or run wemux-lite-worker register / start manually.'
fi
`

export interface WorkerDownloads { tarballPath: string }

export async function serveWorkerDownload(response: ServerResponse, path: string, downloads: WorkerDownloads | undefined): Promise<boolean> {
  if (path === workerInstallerPath) {
    response.writeHead(200, {
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Content-Disposition': 'inline; filename="install-worker.sh"',
      'Content-Length': Buffer.byteLength(installer),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(installer)
    return true
  }
  if (path !== workerTarballPath) return false
  if (!downloads) throw new AppError(503, 'Worker package is not configured')
  let file
  try { file = await open(downloads.tarballPath, 'r') }
  catch { throw new AppError(503, 'Worker package is unavailable') }
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new AppError(503, 'Worker package is unavailable')
    response.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': 'attachment; filename="wemux-lite-worker.tgz"',
      'Content-Length': metadata.size,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    })
    await pipeline(file.createReadStream(), response)
  } catch (error) {
    await file.close().catch(() => undefined)
    throw error
  }
  return true
}
