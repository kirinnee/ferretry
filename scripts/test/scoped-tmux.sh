#!/usr/bin/env bash
set -euo pipefail

[ -z "${FY_E2E_REAL_TMUX:-}" ] && echo "❌ 'FY_E2E_REAL_TMUX' env var not set" >&2 && exit 1
[ -z "${FY_E2E_TMUX_SOCKET:-}" ] && echo "❌ 'FY_E2E_TMUX_SOCKET' env var not set" >&2 && exit 1

case "${FY_E2E_REAL_TMUX}" in
/*) ;;
*)
  echo "❌ 'FY_E2E_REAL_TMUX' must be an absolute path" >&2
  exit 1
  ;;
esac

[ ! -x "${FY_E2E_REAL_TMUX}" ] && echo "❌ 'FY_E2E_REAL_TMUX' is not executable" >&2 && exit 1

case "${FY_E2E_TMUX_SOCKET}" in
/*) ;;
*)
  echo "❌ 'FY_E2E_TMUX_SOCKET' must be an absolute path" >&2
  exit 1
  ;;
esac

for argument in "$@"; do
  case "${argument}" in
  -S* | -L* | --socket | --socket=* | --socket-name | --socket-name=* | --socket-path | --socket-path=*)
    echo "❌ caller-supplied tmux socket overrides are forbidden" >&2
    exit 1
    ;;
  esac
done

exec "${FY_E2E_REAL_TMUX}" -S "${FY_E2E_TMUX_SOCKET}" "$@"
