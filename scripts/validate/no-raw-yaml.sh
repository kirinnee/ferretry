#!/usr/bin/env bash
set -euo pipefail

# Fails when product code gains a YAML reader of its own that the ledger does not list.
#
# WHY. One long string aliased many times made `Bun.YAML.parse` of a 256 KiB `gate.yaml` take 2.3 s and 5.4 GB at
# every daemon boot, while the kernel's bounded reader refused the same file in one linear pass. Every daemon-side
# reader of text a person or an agent can write goes through that reader, or the value the kernel already checked.
#
# HOW. `no-raw-yaml.ts` WALKS THE SYNTAX TREE of every tracked product file under `packages/` (tests, fixtures and test
# support are out of scope) and refuses any use of Bun's `YAML` but `stringify` however it is reached (aliased or
# namespace import, destructure, computed key, dynamic import, a name for `Bun`), any import of a module with `yaml` in
# its name, and any load of a ledgered parser by a file the ledger does not name (laundering). The ledger
# (`scripts/validate/raw-yaml-allowlist.txt`) lists files, their parsing exports and those exports' callers, each
# with a reason. EXACT BOTH WAYS: a listed file, export or caller that no longer applies fails too.
#
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

scanner="scripts/validate/no-raw-yaml.ts"
[ ! -f "${scanner}" ] && echo "❌ missing raw-YAML scanner: ${scanner}" >&2 && exit 2
! command -v bun >/dev/null 2>&1 && echo "❌ bun is required to run ${scanner}" >&2 && exit 2

exec bun "${scanner}" "${root_dir}"
