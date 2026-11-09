#!/usr/bin/env bash
set -euo pipefail

# The 5.0 try-it preview, beside v4. OWNER-RUN after review; an agent only ever runs `dry-run`.
#
#   migration/v4-to-v5/preview/preview.sh <command> [--v4 <home>] [--target <home>] [--source <5.0 checkout>]
#
#   dry-run   print what would be copied, left out, converted and started. Touches nothing.
#   prepare   copy a snapshot of v4 (credentials left out by path), convert it into the preview home, prove v4 unchanged,
#             write the `fy5` wrapper. Never stops or writes to v4.
#   build     compile fy, fyd and the browser worker from a rebuild/5.0 checkout with the preview app origin, into
#             <target>/bin. Needs the preview signing key committed on that checkout (setup-pwa-release-v5.sh).
#   start     fy5 daemon start         (port 7458, own home, own terminal socket, no service unit)
#   stop      fy5 daemon stop
#   status    fy5 daemon status
#   clean     remove the preview home. Refuses while the preview daemon answers.
#
# v4 stays on 7457 under ~/.ferretry. Nothing here touches it, installs a systemd or launchd unit, or mints a pairing
# code: the owner runs `fy5 pair` on their own screen.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tool_dir="$(dirname "${here}")"

command="${1:-}"
[ -n "${command}" ] && shift

v4_home="${HOME}/.ferretry"
target="${HOME}/.ferretry-v5"
source_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
  --v4)
    v4_home="${2:?--v4 needs a folder}"
    shift 2
    ;;
  --target)
    target="${2:?--target needs a folder}"
    shift 2
    ;;
  --source)
    source_dir="${2:?--source needs a folder}"
    shift 2
    ;;
  *)
    echo "unknown argument: $1" >&2
    exit 64
    ;;
  esac
done

if [ "${v4_home}" = "${target}" ]; then
  echo "the preview home must not be the v4 home" >&2
  exit 64
fi

# One fact, one owner: the port and the app origin are read from plan.ts, never restated here.
fact() { (cd "${tool_dir}" && bun -e "import { PREVIEW } from './preview/plan.ts'; console.log(PREVIEW.$1)"); }
run_tool() { (cd "${tool_dir}" && bun preview/main.ts "$@" --v4 "${v4_home}" --target "${target}"); }
fy5() { "${target}/bin/fy5" "$@"; }

case "${command}" in
dry-run) run_tool dry-run ;;
prepare)
  # Never opens a v4 file before the preview home is known to be new.
  if [ -e "${target}" ] && [ -n "$(ls -A "${target}" 2>/dev/null)" ]; then
    echo "${target} already exists; run '$0 clean' first" >&2
    exit 1
  fi
  run_tool prepare
  run_tool wrapper
  ;;
build)
  [ -n "${source_dir}" ] || {
    echo "build needs --source <a rebuild/5.0 checkout>" >&2
    exit 64
  }
  branch="$(git -C "${source_dir}" rev-parse --abbrev-ref HEAD)"
  case "${branch}" in
  rebuild/5.0 | rebuild/preview-v5) ;;
  *)
    echo "refusing to build from '${branch}': the preview is built from rebuild/5.0 only" >&2
    exit 1
    ;;
  esac
  app_origin="$(fact appOrigin)"
  out="$(mktemp -d)"
  trap 'rm -rf "${out}"' EXIT
  (cd "${source_dir}" && FY_HOSTED_APP_ORIGIN="${app_origin}" COMPILE_TARGETS=linux-x64-baseline COMPILE_OUTDIR="${out}" ./scripts/release/compile.sh)
  mkdir -p "${target}/bin"
  for name in fy fyd fyd-browser-worker; do
    install -m 0755 "${out}/${name}-linux-x64-baseline" "${target}/bin/${name}"
  done
  echo "installed fy, fyd and fyd-browser-worker into ${target}/bin"
  ;;
start) fy5 daemon start ;;
stop) fy5 daemon stop ;;
status) fy5 daemon status ;;
clean)
  port="$(fact port)"
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null || { [ -x "${target}/bin/fy5" ] && fy5 daemon status >/dev/null 2>&1; }; then
    echo "something answers on the preview port, or the preview daemon is running; run '$0 stop' first" >&2
    exit 1
  fi
  rm -rf -- "${target}" "${target}.staging"
  echo "removed ${target}"
  ;;
*)
  echo "usage: $0 <dry-run|prepare|build|start|stop|status|clean> [--v4 <home>] [--target <home>] [--source <5.0 checkout>]" >&2
  exit 64
  ;;
esac
