#!/usr/bin/env bash
set -euo pipefail

# Judge the mode git RECORDS, not the working-tree bit. A fresh checkout (CI, another worktree) only
# has the recorded mode, and `core.fileMode=false` (this repo's shared .git/config) makes git ignore
# `chmod` and add every new file as 100644 while the file on disk can still pass `[ -x ]`.
while IFS=$'\t' read -r meta file; do
  mode="${meta%% *}"
  [ "${mode}" = "100755" ] || {
    echo "❌ '${file}' is tracked but not executable (recorded mode ${mode}; fix: chmod +x and git update-index --chmod=+x)" >&2
    exit 1
  }
done < <(git ls-files -s -- '*.sh' 'scripts/host/ferretry-loopback-firewall')

echo "✅ Tracked shell scripts are executable"
