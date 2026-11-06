#!/usr/bin/env bash
set -euo pipefail

hook=${1:?hook id required}
# Every configured non-format hook is read-only in the checkout. The worktree-hook proof writes
# only to its own mktemp repository, and all hooks use language: system (no shared env installs).
PRE_COMMIT_HOME="$(mktemp -d)"
export PRE_COMMIT_HOME
trap 'rm -rf "${PRE_COMMIT_HOME}"' EXIT
pre-commit run "${hook}" --all-files --show-diff-on-failure
