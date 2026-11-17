#!/usr/bin/env bash
set -euo pipefail

# Takes sweep slot N down: each daemon's user service stopped (fy4-slot<N>.service, fy5-slot<N>.service; for a daemon an older kit
# started outside a unit, SIGTERM to the process that holds its OWN lock file, never by name or pattern), the
# tmux server of each home killed by its OWN socket (its fy<4|5>-slot<N>-terminals scope ends with it), the wrappers removed, then the slot folder under
# /tmp/claude-1000/sweep/ deleted (--keep-files keeps it).
#
#   sweep-down.sh <1..9> [--keep-files]
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
slot="${1:?usage: sweep-down.sh <slot 1..9> [--keep-files]}"
shift
exec bun "${here}/slot.ts" down "${slot}" "$@"
