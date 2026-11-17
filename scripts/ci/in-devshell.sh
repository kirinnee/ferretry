#!/usr/bin/env bash
set -euo pipefail

# Runs a command inside the job's flake dev shell, from the environment `nix-realise.sh` already printed.
#
# `nix develop .#ci -c <command>` evaluates the flake and builds the shell's environment again on every
# call: about 3.5 s a step, measured, against 0.1 s to source the same `nix print-dev-env` output the
# install step had to produce anyway to realise the shell. The environment is identical — it IS the
# output of `nix print-dev-env` — including the shellHook, which still links the generated pre-commit
# config. Without that file (a local run, a job that never ran the install action) it is `nix develop`.
#
# WHICH BASH SOURCES IT. The printed environment is nixpkgs' stdenv `setup.sh`, written for the bash the
# shell ships (5.x): it uses `;&` in `substituteStream` and `local -n`, which macOS's /bin/bash 3.2 cannot
# even parse ("syntax error near unexpected token `;'" at the first `source`). A macOS step runs
# `shell: bash`, which is that 3.2, and Apple will not ship a newer one. So this script — which itself
# stays plain bash 3.2 — hands itself to the bash the environment names (its own `BASH=` line, a path in
# the closure `nix print-dev-env` just realised) before it sources anything. On Linux that is the
# bash the runner already had, one `exec` further.
#
# Usage: scripts/ci/in-devshell.sh <command> [args...]

if [[ -n ${FY_DEVSHELL_ENV:-} && -r ${FY_DEVSHELL_ENV} ]]; then
  # `BASH='<store path>'` is one line of the printed environment (nix quotes it with single quotes).
  shell_bash="$(sed -n "s/^BASH='\\(.*\\)'\$/\\1/p" "${FY_DEVSHELL_ENV}" | head -n 1)"
  if [[ -n ${shell_bash} && ${BASH:-} != "${shell_bash}" ]]; then
    if [[ ! -x ${shell_bash} ]]; then
      echo "❌ ${FY_DEVSHELL_ENV} names ${shell_bash} as its bash, but it is not executable; re-run scripts/ci/nix-realise.sh" >&2
      exit 1
    fi
    exec "${shell_bash}" "$0" "$@"
  fi
  # shellcheck disable=SC1090 # the environment nix-realise.sh printed for this job
  source "${FY_DEVSHELL_ENV}"
  exec "$@"
fi
exec nix develop "${FY_DEVSHELL:-.#ci}" -c "$@"
