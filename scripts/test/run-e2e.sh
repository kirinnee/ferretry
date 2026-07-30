#!/usr/bin/env bash
set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

real_tmux="${FY_E2E_REAL_TMUX:-}"
if [ -z "${real_tmux}" ]; then
  set +e
  real_tmux="$(command -v tmux)"
  tmux_lookup_status=$?
  set -e
  [ "${tmux_lookup_status}" -ne 0 ] && real_tmux=""
fi
[ -z "${real_tmux}" ] && echo "❌ tmux is required for the E2E tier" >&2 && exit 1

case "${real_tmux}" in
/*) ;;
*)
  echo "❌ the real tmux executable must resolve to an absolute path" >&2
  exit 1
  ;;
esac

[ ! -x "${real_tmux}" ] && echo "❌ the real tmux executable is not executable" >&2 && exit 1
real_tmux="$(realpath "${real_tmux}")"
export FY_E2E_REAL_TMUX="${real_tmux}"

if [ -z "${CLI_BIN:-}" ]; then
  cli_prefix="$(jq -r '.bin | to_entries | if length == 1 then .[0].key else empty end' packages/cli/package.json)"
  [ -z "${cli_prefix}" ] && echo "❌ packages/cli/package.json must have exactly one .bin entry" >&2 && exit 1

  case "$(uname -s)" in
  Linux) cli_os="linux" ;;
  Darwin) cli_os="darwin" ;;
  *)
    echo "❌ unsupported E2E host operating system" >&2
    exit 1
    ;;
  esac

  case "$(uname -m)" in
  x86_64 | amd64) cli_arch="x64-baseline" ;;
  arm64 | aarch64) cli_arch="arm64" ;;
  *)
    echo "❌ unsupported E2E host architecture" >&2
    exit 1
    ;;
  esac

  CLI_BIN="dist/bin/${cli_prefix}-${cli_os}-${cli_arch}"
fi

case "${CLI_BIN}" in
/*) cli_candidate="${CLI_BIN}" ;;
*) cli_candidate="${root_dir}/${CLI_BIN}" ;;
esac

[ ! -f "${cli_candidate}" ] && echo "❌ E2E CLI binary does not exist: ${cli_candidate}" >&2 && exit 1
[ ! -x "${cli_candidate}" ] && echo "❌ E2E CLI binary is not executable: ${cli_candidate}" >&2 && exit 1
CLI_BIN="$(realpath "${cli_candidate}")"
export CLI_BIN

run_root=""
cleanup() {
  status=$?
  trap - EXIT INT TERM
  set +e

  if [ -n "${run_root}" ] && [ "${run_root}" != "/" ] && [ -d "${run_root}" ]; then
    while IFS= read -r -d '' socket; do
      case "${socket}" in
      "${run_root}"/*) "${real_tmux}" -S "${socket}" kill-server >/dev/null 2>&1 ;;
      esac
    done < <(find "${run_root}" -type s -name 'tmux*.sock' -print0)
    rm -rf -- "${run_root}"
  fi

  exit "${status}"
}

run_root="$(mktemp -d "${TMPDIR:-/tmp}/fy-e2e.XXXXXXXX")"
case "${run_root}" in
/*) ;;
*)
  echo "❌ E2E suite root did not resolve to an absolute path" >&2
  exit 1
  ;;
esac
[ "${run_root}" = "/" ] && echo "❌ refusing to use the filesystem root as the E2E suite root" >&2 && exit 1

export FY_E2E_RUN_ROOT="${run_root}"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "🧪 Typechecking the E2E harness..."
./node_modules/.bin/tsc --noEmit --project tests/e2e/tsconfig.json

echo "🧪 Running isolated E2E journeys..."
bun test tests/e2e --config=bunfig.e2e.toml

echo "✅ Isolated E2E journeys passed"
