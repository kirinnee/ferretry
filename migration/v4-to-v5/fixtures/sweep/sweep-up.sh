#!/usr/bin/env bash
set -euo pipefail

# Brings sweep slot N (1..8) up: a RICH v4 home built through v4's own CLI, the 5.0 conversion of a COPY of it, and a
# daemon on each (v4 on 7600+2N, 5.0 on 7601+2N), side by side on the same data. Everything lives under
# /tmp/claude-1000/sweep/slot<N>/ and nothing outside it is written. Re-running it after sweep-down.sh gives a fresh,
# identical pair (it rebuilds from scratch: a few minutes).
#
#   sweep-up.sh <1..8>
#
# See SWEEP.md for what the home holds, the wrappers (fy4s<N>, fy5s<N>), pairing an agent browser, and the limits.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -lt 1 ]; then
  echo "usage: sweep-up.sh <slot 1..8>" >&2
  exit 64
fi
exec bun "${here}/slot.ts" up "$@"
