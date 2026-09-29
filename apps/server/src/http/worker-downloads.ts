import { ncDownloadScript } from '@wemux/web-contract'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { AppError } from '../application/errors.ts'

export const workerTarballPath = '/downloads/worker.tgz'
export const workerManifestPath = '/downloads/worker-manifest.json'
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
case "$nc_transport" in direct|nc) ;; *) printf '%s\n' 'WEMUX_TRANSPORT must be direct or nc' >&2; exit 64 ;; esac
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
    case "$candidate" in https://*) candidate_protocol='=https' ;; *) candidate_protocol='=http,https' ;; esac
    if curl --proto "$candidate_protocol" --proto-redir "$candidate_protocol" -fsS --connect-timeout 10 \
        "$candidate${workerTarballPath}" -o "$temporary_directory/worker.tgz"; then
      download_ok=1; server_url="$candidate"; break
    fi
  done
fi
if [ "$download_ok" != 1 ]; then
  printf 'Failed to download worker.tgz from any of: %s\n' "$server_urls" >&2
  exit 69
fi
# The same-origin manifest detects corrupt or mismatched downloads. Only HTTPS
# authenticates a remote Server; plain HTTP needs a trusted private network.
if ! command -v node >/dev/null 2>&1 || ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)' ; then
  printf '%s\n' 'Node >=22.13 is required' >&2; exit 69
fi
if [ "$nc_transport" = "nc" ]; then
  node -e '${ncDownloadScript}' "$host" "$port" "${workerManifestPath}" "$temporary_directory/worker-manifest.json"
else
  case "$server_url" in https://*) manifest_protocol='=https' ;; *) manifest_protocol='=http,https' ;; esac
  curl --proto "$manifest_protocol" --proto-redir "$manifest_protocol" -fsS --connect-timeout 10 \
    "$server_url${workerManifestPath}" -o "$temporary_directory/worker-manifest.json"
fi
if ! node -e '
const fs = require("node:fs"), crypto = require("node:crypto");
try {
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const packageFile = fs.readFileSync(process.argv[2]);
  if (manifest.schemaVersion !== 1 || manifest.filename !== "worker.tgz" ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 ||
      manifest.bytes !== packageFile.length ||
      crypto.createHash("sha256").update(packageFile).digest("hex") !== manifest.sha256) process.exit(1);
} catch { process.exit(1); }
' "$temporary_directory/worker-manifest.json" "$temporary_directory/worker.tgz"; then
  printf '%s\n' 'Worker package integrity verification failed; installation aborted' >&2
  exit 65
fi
printf '%s\n' 'Verified package SHA-256. Installing Worker and required dependencies (no Agent runtime will be installed) ...' >&2
install_mode="${'${WEMUX_INSTALL_MODE:-managed}'}"
case "$install_mode" in managed|global) ;; *) printf '%s\n' 'WEMUX_INSTALL_MODE must be managed or global' >&2; exit 64 ;; esac
if [ "$install_mode" = managed ]; then
  # A user systemd manager is mandatory for a persistent deployment. Never
  # silently report success after launching a foreground or background child.
  if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    printf '%s\n' 'npm and a running systemd --user manager are required; use WEMUX_INSTALL_MODE=global for a manual foreground installation' >&2
    exit 69
  fi
  if [ -z "${'${WEMUX_WORKER_NAME:-}'}" ]; then
    printf '%s\n' 'Managed install requires WEMUX_WORKER_NAME' >&2
    exit 64
  fi
  install_root="${'${WEMUX_INSTALL_ROOT:-${HOME}/.local/share/wemux-lite-worker}'}"
  worker_home="${'${WEMUX_WORKER_HOME:-${HOME}/.wemux-lite}'}"
  service_dir="${'${XDG_CONFIG_HOME:-${HOME}/.config}'}/systemd/user"
  # systemd ExecStart arguments must be absolute and have no control characters.
  if ! node -e 'const paths=process.argv.slice(1); process.exit(paths.every(p=>p.startsWith("/") && !/[\\x00-\\x1f\\x7f]/.test(p))?0:1)' "$install_root" "$worker_home" "$service_dir"; then
    printf '%s\n' 'Install, Worker home and service paths must be absolute without control characters' >&2; exit 64
  fi
  # A symlinked home or install path could redirect package staging outside the
  # selected directory. Reject it before touching service or credentials.
  if [ -L "$install_root" ] || [ -L "$worker_home" ]; then printf '%s\n' 'Symlinked install root or Worker home is not supported' >&2; exit 64; fi
  mkdir -p "$install_root/releases" "$service_dir"
  chmod 700 "$install_root" "$install_root/releases"
  if [ -L "$install_root/releases" ] || { [ -e "$install_root/current" ] && [ ! -L "$install_root/current" ]; }; then
    printf '%s\n' 'Invalid release directory or current pointer' >&2; exit 64
  fi
  if ! mkdir "$install_root/.install-lock" 2>/dev/null; then
    printf '%s\n' 'Another Worker installation is in progress; retry after it finishes' >&2; exit 75
  fi
  rollback_pending=0
  old_current=''
  previous_unit=''
  service_path=''
  cleanup_install() {
    status=$?
    if [ "$rollback_pending" = 1 ]; then
      rm -f "$install_root/.current.$$" "$install_root/.rollback.$$"
      if [ -n "$old_current" ]; then
        ln -s "$old_current" "$install_root/.rollback.$$"
        mv -f "$install_root/.rollback.$$" "$install_root/current"
      else
        rm -f "$install_root/current"
      fi
      if [ -f "$previous_unit" ]; then cp "$previous_unit" "$service_path"; else rm -f "$service_path"; fi
      systemctl --user daemon-reload || true
      if [ -n "$old_current" ]; then systemctl --user restart wemux-lite-worker.service || true
      else systemctl --user disable --now wemux-lite-worker.service || true; fi
    fi
    rm -rf "$temporary_directory"
    rmdir "$install_root/.install-lock"
    exit "$status"
  }
  trap cleanup_install EXIT
  # npm installs into a private staging prefix. The verified package hash names
  # the release. Never overwrite an already published release in place.
  release_hash="$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$temporary_directory/worker.tgz")"
  release="$install_root/releases/$release_hash"
  if [ -L "$release" ]; then printf '%s\n' 'Worker release path must not be a symlink' >&2; exit 70; fi
  if [ ! -d "$release" ]; then
    stage="$(mktemp -d "$install_root/.stage.XXXXXX")"
    if ! npm install --prefix "$stage" --ignore-scripts --no-audit --no-fund --omit=dev "$temporary_directory/worker.tgz"; then rm -rf "$stage"; exit 70; fi
    if ! node "$stage/node_modules/@wemux/worker/dist/cli.js" version | grep -q '^wemux-lite-worker '; then rm -rf "$stage"; printf '%s\n' 'Installed Worker failed its version probe' >&2; exit 70; fi
    mv "$stage" "$release"
  fi
  worker_cli="$release/node_modules/@wemux/worker/dist/cli.js"
  if ! node "$worker_cli" version | grep -q '^wemux-lite-worker '; then printf '%s\n' 'Worker release failed its version probe' >&2; exit 70; fi
  # Identity and credentials live outside the release. Registration of an
  # already enrolled home is intentionally skipped during upgrades.
  if [ ! -f "$worker_home/credential" ]; then
    if [ -z "${'${WEMUX_ENROLLMENT_TOKEN:-}'}" ]; then printf '%s\n' 'First registration requires WEMUX_ENROLLMENT_TOKEN' >&2; exit 64; fi
    node "$worker_cli" register --home "$worker_home" --server "$server_url" --servers "$server_urls" --name "$WEMUX_WORKER_NAME" --transport "$nc_transport"
  fi
  old_current="$(readlink "$install_root/current" 2>/dev/null || true)"
  if [ -n "$old_current" ] && ! node -e 'process.exit(new RegExp("^releases/[a-f0-9]{64}$").test(process.argv[1]) ? 0 : 1)' "$old_current"; then
    printf '%s\n' 'Invalid previous release pointer' >&2; exit 70
  fi
  service_path="$service_dir/wemux-lite-worker.service"
  previous_unit="$temporary_directory/previous.service"
  if [ -f "$service_path" ]; then cp "$service_path" "$previous_unit"; fi
  rollback_pending=1
  if [ "$old_current" != "releases/$release_hash" ]; then
    ln -s "releases/$release_hash" "$install_root/.current.$$"
    mv -f "$install_root/.current.$$" "$install_root/current"
  fi
  # Paths are escaped for the systemd unit grammar, not executed by a shell.
  node -e '
const fs=require("node:fs");
const [target, root, home, transport]=process.argv.slice(1);
const quote=value => "\\\"" + value.replaceAll("%", "%%").replaceAll("\\\\", "\\\\\\\\").replaceAll("\\\"", "\\\\\\\"") + "\\\"";
const unit="[Unit]\\nDescription=Wemux Lite Worker\\nAfter=network-online.target\\nWants=network-online.target\\n[Service]\\nType=simple\\nExecStart="+quote(process.execPath)+" "+quote(root+"/current/node_modules/@wemux/worker/dist/cli.js")+" start --home "+quote(home)+" --transport "+transport+"\\nRestart=on-failure\\nRestartSec=5\\n[Install]\\nWantedBy=default.target\\n";
fs.writeFileSync(target,unit,{mode:0o600});
' "$service_path" "$install_root" "$worker_home" "$nc_transport"
  chmod 600 "$service_path"
  systemctl --user daemon-reload
  systemctl --user enable wemux-lite-worker.service
  healthy=0
  if systemctl --user restart wemux-lite-worker.service; then
    attempt=0
    while [ "$attempt" -lt 5 ]; do
      if systemctl --user is-active --quiet wemux-lite-worker.service; then healthy=1; break; fi
      attempt=$((attempt + 1)); sleep 1
    done
  fi
  if [ "$healthy" != 1 ]; then
    printf '%s\n' 'Worker service did not become active; previous release will be restored when available' >&2
    exit 70
  fi
  rollback_pending=0
  printf 'Worker installed and user service active (%s). Verify cluster connection and Agent credentials separately.\n' "$release_hash" >&2
  exit 0
fi
npm install --global --ignore-scripts --no-audit --no-fund "$temporary_directory/worker.tgz"
printf '%s\n' 'Worker installed in explicit global/manual mode.' >&2

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
  if (path !== workerTarballPath && path !== workerManifestPath) return false
  if (!downloads) throw new AppError(503, 'Worker package is not configured')
  let file
  try { file = await open(downloads.tarballPath, 'r') }
  catch { throw new AppError(503, 'Worker package is unavailable') }
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new AppError(503, 'Worker package is unavailable')
    if (path === workerManifestPath) {
      const hash = createHash('sha256')
      for await (const chunk of file.createReadStream()) hash.update(chunk)
      const body = JSON.stringify({ schemaVersion: 1, filename: 'worker.tgz', sha256: hash.digest('hex'), bytes: metadata.size })
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      response.end(body)
      return true
    }
    response.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': 'attachment; filename="wemux-lite-worker.tgz"',
      'Content-Length': metadata.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    await pipeline(file.createReadStream(), response)
  } catch (error) {
    await file.close().catch(() => undefined)
    throw error
  }
  return true
}
