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
# Usage: scripts/ci/in-devshell.sh <command> [args...]

if [[ -n ${FY_DEVSHELL_ENV:-} && -r ${FY_DEVSHELL_ENV} ]]; then
  # shellcheck disable=SC1090 # the environment nix-realise.sh printed for this job
  source "${FY_DEVSHELL_ENV}"
  exec "$@"
fi
exec nix develop "${FY_DEVSHELL:-.#ci}" -c "$@"
