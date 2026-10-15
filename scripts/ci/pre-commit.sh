#!/usr/bin/env bash
set -euo pipefail

# One part of the gate, or all of it (no argument — the local default). CI runs the two parts on
# parallel runners because every hook runs one after another: `format` (treefmt over every file) was
# ~40s of the ~105s the hooks took in series, and `gates` is everything else. Together the parts run
# exactly the hooks one unsplit run does — `SKIP` names the hook the other part owns.
part="${1:-all}"

./scripts/ci/setup.sh
case "${part}" in
all) pre-commit run --all-files --show-diff-on-failure ;;
format) pre-commit run treefmt --all-files --show-diff-on-failure ;;
gates) SKIP=treefmt pre-commit run --all-files --show-diff-on-failure ;;
*) echo "❌ usage: $0 [all|format|gates]" >&2 && exit 2 ;;
esac

echo "✅ Pre-commit gates passed (${part})"
