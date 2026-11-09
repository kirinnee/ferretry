#!/usr/bin/env bash
set -euo pipefail

# The 5.0 try-it preview, beside v4. OWNER-RUN after review; an agent only ever runs `dry-run`.
#
#   migration/v4-to-v5/preview/preview.sh <command> [--v4 <home>] [--target <home>] [--source <5.0 checkout>]
#
#   dry-run   print what would be copied, left out, converted and started. Touches nothing.
#   prepare   copy a snapshot of v4 (credentials left out by path), convert it into the preview home, prove v4 unchanged,
#             write the `fy5` wrapper. Never stops or writes to v4. It reads each config/logins/*.yaml once, for its
#             `harness` field (and whether it has both claude and codex halves) only, to know which runtimes are Claude
#             Code ones; no other key of a login is kept, and an agent's dry-run reads no login file.
#             --owner (OWNER ONLY, never an agent): records as accepted every config file the preview wrote or
#             changed (found by comparing with the plain conversion: terminals.yaml, claude-code/settings/fy-preview.yaml,
#             the forced limits.yaml), EXCEPT any that comes from a v4 file with an unconfirmed edit: each stays held
#             (the printed note and the report name every one, with the reason). Confirm the edit in v4,
#             then `clean` and `prepare --owner`. Without --owner they are all held and `start` stops the daemon.
#             --drop-uncarried (prepare ONLY; dry-run ignores it. OWNER'S CHOICE, never the default; an agent never passes
#             it without the owner's yes): a settings or hooks component the converter cannot carry (an unsupported flag,
#             a `file:` outside fleet/assets/ (inside the v4 home: v4 would not have read it either; outside the v4
#             home: v4 read it, but the preview carries only files under fleet/assets/, so copy it there), a hard link, a
#             hooks folder, a secret-shaped value...) leaves the Settings step PENDING by default, because a profile still
#             layers it. With this flag its layer is removed from every profile that names it (each profile is named in the
#             report) so the preview can start, and the ferrets on those profiles may be LESS restricted than in v4.
#             A carried settings or hooks string that names a file under <v4 home>/fleet/assets/ (absolute, or ~/ $HOME/
#             ${HOME}/ spellings that resolve to it, as a whole path token) has that FILE carried to the same path under
#             the preview home's fleet/assets/ and only the token rewritten to it (mode 0600, or 0700 when the source is
#             owner-executable; refused for a link, hard link, over 1 MiB, a credential, or content that names v4's
#             home or worktree folder or a ~/.claude* or ~/.codex* home). Any other string naming the
#             v4 home leaves the component NOT CARRIED: copy the file under fleet/assets in v4, or remove the hook.
#   build     compile fy, fyd and the browser worker from a CLEAN rebuild/5.0 checkout with the preview app origin, prove
#             the compiled binaries name that origin, and only then install them into <target>/libexec (bin holds shims
#             that pin the preview). Refuses unless the preview signing key is committed on that checkout
#             (packages/app/release-signing-key.preview.pub, from setup-pwa-release-v5.sh).
#   start     two read-only checks, then fy5 daemon start (port 7458, own home, own terminal socket, no service unit).
#             The daemon runs with NO reachable user systemd manager (a private XDG_RUNTIME_DIR, no session bus), so 5.0 runs
#             launches directly and never reconfigures v4's slices; start REFUSES if a manager is still reachable, or if a
#             login shell with the guard environment finds a `fy` other than the preview's. Once the daemon is up, start
#             opens a terminal through the daemon's own route and requires the preview's `fy` and FY_HOME in it (terminals
#             carry Terminals' `environment` setting); a miss closes that terminal, STOPS the preview daemon and exits 1.
#             A stopped ferret record is enough; with no ferret record yet it proves what the runtime reads live instead.
#   terminal-check  repeat that terminal proof against the running preview daemon (does not stop it on a miss)
#   stop      SIGTERM the process proven to hold the preview home's own daemon lock (never v4's, never a unit)
#   status    fy5 daemon status
#   proof     compare v4 now with the snapshot `prepare` took (kept in ~/.ferretry-v5-proof/, outside the preview home);
#             run it after a start and a stop; names only
#   clean     remove the preview home and its proof, only if `prepare` marked it. Refuses while the preview daemon answers.
#
# fy5 itself refuses `update` and `daemon stop|restart|update|install|uninstall|reset|which|logs`: on a box with v4's service unit they answer
# for v4's unit and write claim files beside it. Use this script's `stop` instead.
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
owner_flag=()
drop_flag=()
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
  --owner)
    owner_flag=(--owner)
    shift
    ;;
  --drop-uncarried)
    drop_flag=(--drop-uncarried)
    shift
    ;;
  *)
    echo "unknown argument: $1" >&2
    exit 64
    ;;
  esac
done

# The converter's own dependencies (yaml, zod) are installed inside migration/v4-to-v5, not by the repo's install.
# dry-run and prepare need them: a missing node_modules is installed here (one line says so); a failure names the command.
if [ "${command}" = "dry-run" ] || [ "${command}" = "prepare" ]; then
  if [ ! -d "${tool_dir}/node_modules/yaml" ]; then
    echo "installing the converter's dependencies (migration/v4-to-v5/node_modules is missing or has no yaml)"
    if ! (cd "${tool_dir}" && bun install --frozen-lockfile >/dev/null); then
      echo "could not install the converter's dependencies; run: cd '${tool_dir}' && bun install --frozen-lockfile" >&2
      exit 1
    fi
  fi
fi

# One fact, one owner: the port and the app origin are read from plan.ts, never restated here.
fact() { (cd "${tool_dir}" && bun -e "import { PREVIEW } from './preview/plan.ts'; console.log(PREVIEW.$1)"); }
run_tool() { (cd "${tool_dir}" && bun preview/main.ts "$@" --v4 "${v4_home}" --target "${target}"); }
fy5() { "${target}/bin/fy5" "$@"; }

# One owner for where the preview may write and remove (preview/paths.ts): it resolves links, refuses `..`, v4's home
# (equal, inside or containing it), the user's home and `/`, and answers with the resolved spelling used from here on.
# Captured first, so a refusal stops the script (a failure inside a pipe or process substitution would not).
resolved="$(run_tool guard)"
v4_home="$(printf '%s\n' "${resolved}" | sed -n 1p)"
target="$(printf '%s\n' "${resolved}" | sed -n 2p)"

case "${command}" in
dry-run) run_tool dry-run ;; # converts nothing, so --drop-uncarried means nothing here
prepare)
  # Never opens a v4 file before the preview home is known to be new.
  if [ -e "${target}" ] && [ -n "$(ls -A "${target}" 2>/dev/null)" ]; then
    echo "${target} already exists; run '$0 clean' first. If clean refuses it (a prepare that died before its marker), remove it yourself:" >&2
    echo "  rm -rf '${target}' '${target}.staging' '${target}.conversion-report.json'   (and, if it exists, its proof file in ~/.ferretry-v5-proof/)" >&2
    exit 1
  fi
  run_tool prepare ${owner_flag[@]+"${owner_flag[@]}"} ${drop_flag[@]+"${drop_flag[@]}"}
  run_tool wrapper
  ;;
build)
  [ -n "${source_dir}" ] || {
    echo "build needs --source <a rebuild/5.0 checkout>" >&2
    exit 64
  }
  branch="$(git -C "${source_dir}" symbolic-ref --short -q HEAD || true)"
  if [ -z "${branch}" ]; then
    echo "refusing to build: HEAD of ${source_dir} is detached; check out rebuild/5.0" >&2
    exit 1
  fi
  if [ "${branch}" != "rebuild/5.0" ]; then
    echo "refusing to build from '${branch}': the preview is built from rebuild/5.0 only" >&2
    exit 1
  fi
  dirty="$(git -C "${source_dir}" status --porcelain)"
  if [ -n "${dirty}" ]; then
    echo "refusing to build: ${source_dir} has uncommitted changes; commit or stash them first" >&2
    exit 1
  fi
  # The daemon is signed against the PREVIEW key: without the committed public half it would trust nothing the v5 app signs.
  if [ ! -f "${source_dir}/packages/app/release-signing-key.preview.pub" ]; then
    echo "refusing to build: ${source_dir}/packages/app/release-signing-key.preview.pub is missing." >&2
    echo "Owner step: run scripts/local/setup-pwa-release-v5.sh, commit the public key it prints to rebuild/5.0 at that path, then build again." >&2
    exit 1
  fi
  app_origin="$(fact appOrigin)"
  out="$(mktemp -d)"
  trap 'rm -rf "${out}"' EXIT
  (cd "${source_dir}" && FY_HOSTED_APP_ORIGIN="${app_origin}" COMPILE_TARGETS=linux-x64-baseline COMPILE_OUTDIR="${out}" ./scripts/release/compile.sh)
  # Prove it BEFORE anything is installed: a binary that does not name the preview origin would pair the owner's v4 app.
  for name in fy fyd; do
    if ! grep -aqF -- "${app_origin}" "${out}/${name}-linux-x64-baseline"; then
      echo "refusing to install: the compiled ${name} does not name ${app_origin}" >&2
      exit 1
    fi
  done
  # The raw programs go to libexec; `prepare` writes pinning shims of the same names into bin (never v4's `fy` from PATH).
  mkdir -p "${target}/libexec"
  for name in fy fyd fyd-browser-worker; do
    install -m 0755 "${out}/${name}-linux-x64-baseline" "${target}/libexec/${name}"
  done
  echo "installed fy, fyd and fyd-browser-worker into ${target}/libexec"
  ;;
start)
  # Two read-only checks first, with the preview's exact environments; a failure refuses to start (nothing is started).
  #   1. the daemon's environment reaches NO user systemd manager (else it would reset v4's slices);
  #   2. bash -lc, bash -ic and zsh -lic with the guard environment find the preview's own fy (else a login shell finds v4's).
  [ -x "${target}/bin/fy5" ] || {
    echo "refusing to start: ${target}/bin/fy5 is missing; run '$0 prepare' first" >&2
    exit 1
  }
  run_tool start-checks
  fy5 daemon start
  # 3. A terminal the daemon opens carries the preview environment: proved through the daemon's own route.
  # On ANY miss the daemon just started is stopped again: terminals it opens may reach v4's `fy`.
  if ! run_tool terminal-check; then
    if run_tool stop; then
      echo "refusing to go on: the preview daemon was stopped because the terminal proof failed (nothing is left running)." >&2
    else
      echo "refusing to go on: the terminal proof failed AND the preview daemon could not be stopped; run '$0 stop' now." >&2
    fi
    exit 1
  fi
  ;;
terminal-check) run_tool terminal-check ;;
stop) run_tool stop ;;
status) fy5 daemon status ;;
proof) run_tool proof ;;
clean)
  port="$(fact port)"
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null || { [ -x "${target}/bin/fy5" ] && fy5 daemon status >/dev/null 2>&1; }; then
    echo "something answers on the preview port, or the preview daemon is running; run '$0 stop' first" >&2
    exit 1
  fi
  # Removes only a folder `prepare` marked as a preview home.
  run_tool clean
  ;;
*)
  echo "usage: $0 <dry-run|prepare|build|start|terminal-check|stop|status|proof|clean> [--v4 <home>] [--target <home>] [--source <5.0 checkout>] [--owner (prepare, owner only)]" >&2
  exit 64
  ;;
esac
