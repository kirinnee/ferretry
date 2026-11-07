#!/usr/bin/env bash
set -euo pipefail

# THE 5.0 CHECKS (docs/design/redesign.md §7.9): context-imports, contract-graph, plugin-graph, core-closed,
# manifest-match, ports-pending, banned-globals, host-files, registries-fresh, guarantees, no-compat and the
# rest, run over one shared model by the SDK slice's entry, `bun scripts/gen/check.ts` (the same script `fy
# check` calls). One hook runs them all so a check the SDK adds is wired the moment it is in that entry,
# without a second inventory here. Exits 1 on any finding.
#
# DAY-1 ORDERING ONLY: until rebuild/spine-sdk is merged into rebuild/5.0 the entry does not exist on every
# branch, and this says so instead of failing every commit. Once it is merged, delete the branch below so a
# missing entry fails loudly.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

entry="scripts/gen/check.ts"
if [[ ! -f ${entry} ]]; then
  echo "⏳ ${entry} is not on this branch yet (rebuild/spine-sdk): the 5.0 checks did not run"
  exit 0
fi
./scripts/local/gen.sh
exec bun "${entry}" "$@"
