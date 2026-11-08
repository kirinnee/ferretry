#!/usr/bin/env bash
set -euo pipefail

# Fails when product code gains a YAML reader of its own that the ledger does not list.
#
# WHY. One long string aliased many times made `Bun.YAML.parse` of a 256 KiB `gate.yaml` take 2.3 s and 5.4 GB at
# every daemon boot, while the kernel's bounded reader refused the same file in one linear pass. Every daemon-side
# reader of text a person or an agent can write goes through that reader, or the value the kernel already checked.
#
# HOW. `no-raw-yaml.ts` reads every tracked product file under `packages/` (tests, fixtures and test support are out
# of scope) and refuses any `Bun.YAML`, `YAML.parse(` or import of `yaml` / `js-yaml` in a file the ledger
# (`scripts/validate/raw-yaml-allowlist.txt`, one `path  # reason` per line) does not name. EXACT BOTH WAYS: a listed
# file that no longer parses YAML fails too.
#
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

scanner="scripts/validate/no-raw-yaml.ts"
[ ! -f "${scanner}" ] && echo "❌ missing raw-YAML scanner: ${scanner}" >&2 && exit 2
! command -v bun >/dev/null 2>&1 && echo "❌ bun is required to run ${scanner}" >&2 && exit 2

exec bun "${scanner}" "${root_dir}"
