#!/usr/bin/env bash
set -euo pipefail

# The working-tree viewer's containment, proved on the kernel that needs the POSIX pin.
#
# The Linux suite already runs BOTH pinners, so the logic is covered there. What only a macOS runner
# can answer is whether the C calls load at all, whether a relative name really is resolved from the
# installed directory, and whether Git inherits it — three facts about a kernel and a libc that no
# amount of Linux testing establishes. Every one of them is asserted by the same escape tests.
#
# Deliberately NOT the whole integration suite: the rest of it drives tmux, sockets and a daemon that
# this repository does not otherwise support on macOS, and a job that fails for those reasons would say
# nothing about containment. The one tmux-driven file here is the pane registration, because a session
# start on macOS reads its process identity through this kernel's `ps`, and only a Mac can say whether a
# harness that dies at once is reported as the exit it was.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

./scripts/ci/setup.sh

echo "🧪 Proving descriptor containment on $(uname -sm)..."
bun test --config=bunfig.int.toml packages/daemon/tests/integration/session/filesystem/
echo "🧪 Proving the process inventory reads this kernel's ps..."
bun test --config=bunfig.int.toml packages/daemon/tests/integration/migrate/real-ps-inventory.test.ts
echo "🧪 Proving a pane's process identity reads this kernel's ps, and a dead harness says why..."
bun test --config=bunfig.int.toml \
  packages/daemon/tests/integration/session/lifecycle/process-incarnation.test.ts \
  packages/daemon/tests/integration/session/lifecycle/durable-terminal-pane-reap.test.ts
echo "✅ Containment, the process inventory and pane identity hold on $(uname -sm)"
