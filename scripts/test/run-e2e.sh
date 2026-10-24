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
    # By process, not by socket file: a journey's own cleanup removes its root, socket included, and a
    # server it never killed then survives every `kill-server` — which is how a daemon's private tmux,
    # and the real Claude Code in its pane, ran on for days. Every journey kills its own servers, so
    # one still running here is a fixture bug and fails the tier — unless the runner died on a signal,
    # whose leftovers are the crash's and are only swept.
    bun scripts/test/tmux-sweep.ts --fail-on-leak --exit-status "${status}" "${run_root}" || { [ "${status}" -eq 0 ] && status=1; }
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
# Every daemon a journey boots refuses to launch a real harness (packages/daemon/src/lib/tmux/harness-guard.ts).
export FERRETRY_TEST=1
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "🧪 Typechecking the E2E harness..."
./node_modules/.bin/tsc --noEmit --project tests/e2e/tsconfig.json

# THE PER-JOURNEY CEILING. Every journey outside the `[slow]` tier ends at this, so a journey that hangs
# costs a shard minutes rather than the 10–15 it once did. Bun's `--timeout` is only a default a test can
# raise, so the check below refuses a journey that raises it past here
# (scripts/test/e2e-journey-timeouts.ts). The slowest pull-request journey takes about a minute, and a
# journey whose browser vanished is run again from nothing, so this holds a retry; the ceiling bounds
# every attempt together.
journey_timeout_ms=150000
# The journeys read it too: a journey Bun has abandoned at the ceiling must not start a retry.
export FY_E2E_JOURNEY_TIMEOUT_MS="${journey_timeout_ms}"
bun scripts/test/e2e-journey-timeouts.ts "${journey_timeout_ms}" tests/e2e/*.e2e.test.ts

# A TIER AND A SHARD (scripts/ci/e2e-shards.ts): `FY_E2E_TIER` is fast (no `[slow]` journey), slow or
# all, and `FY_E2E_SHARD=i/N` runs this runner's share of it, balanced by tests/e2e/timings.json. With
# neither set, every journey runs here, as it always has.
selection=(tests/e2e)
if [ -n "${FY_E2E_SHARD:-}" ] || [ "${FY_E2E_TIER:-all}" != "all" ]; then
  plan="$(bun scripts/ci/e2e-shards.ts plan "${FY_E2E_TIER:-all}" "${FY_E2E_SHARD:-1/1}")"
  if [ -z "${plan}" ]; then
    echo "✅ this shard of the ${FY_E2E_TIER:-all} tier holds no journeys"
    exit 0
  fi
  mapfile -t selection <<<"${plan}"
fi
# A JUnit report when asked for one: CI keeps it as evidence, and it is what regenerates the timings.
report=()
[ -n "${FY_E2E_JUNIT:-}" ] && report=(--reporter=junit "--reporter-outfile=${FY_E2E_JUNIT}")

echo "🧪 Running isolated E2E journeys..."
# `--timeout` on the command line because `[test] timeout` in a bunfig is ignored by Bun.
bun test "${selection[@]}" --config=bunfig.e2e.toml --timeout "${journey_timeout_ms}" "${report[@]}"

echo "✅ Isolated E2E journeys passed"
