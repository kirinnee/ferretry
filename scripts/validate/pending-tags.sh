#!/usr/bin/env bash
set -euo pipefail

# Fails when a dead-code keep marker is not tied to an open fact.
#
# WHY. The knip gates (knip.json, knip.production.json) skip an export tagged `@pending` or `@public` and a file in a
# workspace's `ignore`. Without a check, either is a quiet way to keep dead code forever.
#
# HOW. `pending-tags.ts`: every `@pending <owner>: <gap>` (gap: 3+ words, 16+ characters) names an open gap line of its own
# package in ports-pending.json `pendingReasons` and fails once that package leaves `pending`; every knip `ignore` (glob
# keys resolved to the packages they match) of a subsystem is named by such a line; every `@public` names a kept
# guarantee row of its own package or `surface <name>` from the manifest (the app shell and CLI: a § ref or an existing
# docs path too); any other keep-alive knip setting needs an ALLOWED_KNIP reason. Comments come from oxc-parser.
#
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

checker="scripts/validate/pending-tags.ts"
[ ! -f "${checker}" ] && echo "❌ missing keep-marker check: ${checker}" >&2 && exit 2
! command -v bun >/dev/null 2>&1 && echo "❌ bun is required to run ${checker}" >&2 && exit 2

exec bun "${checker}"
