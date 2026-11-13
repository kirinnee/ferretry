#!/usr/bin/env bash
set -euo pipefail

# Takes sweep slot N down: SIGTERM to the process that holds each daemon's OWN lock file (never by name or pattern), the
# tmux server of each home killed by its OWN socket, the wrappers removed, then the slot folder under
# /tmp/claude-1000/sweep/ deleted (--keep-files keeps it).
#
#   sweep-down.sh <1..8> [--keep-files]
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
slot="${1:?usage: sweep-down.sh <slot 1..8> [--keep-files]}"
shift
exec bun "${here}/slot.ts" down "${slot}" "$@"
