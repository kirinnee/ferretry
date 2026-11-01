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
# harness that dies at once is reported as the exit it was. The other is the attach adapter: `fy attach`
# once compared a start identity read from `/proc`, which macOS lacks, against the daemon's `ps` value and
# so refused every attach there; only a Mac can show the two sides now read the same number. And the
# file-event hub's macOS source: its directory watches are FSEvents streams, whose events — dot-files like
# Claude's `.credentials.json` included — no Linux runner can produce, so only a Mac can say whether the
# hub's watched paths are really heard rather than polled. And the fleet provisioner's destination side: macOS has no
# `/proc`, so its every step goes through descriptor calls (`fchdir` + prove + one relative call, `linkat`), whose C
# calls load from libSystem — only a Mac can say they load there and reach the held folder, not a swapped path.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

./scripts/ci/setup.sh

echo "🧪 Proving descriptor containment on $(uname -sm)..."
bun test --config=bunfig.int.toml packages/daemon/tests/integration/session/filesystem/
echo "🧪 Proving the process inventory reads this kernel's ps..."
bun test --config=bunfig.int.toml packages/daemon/tests/integration/migrate/real-ps-inventory.test.ts
echo "🧪 Proving a pane's process identity reads this kernel's ps, and a dead harness says why..."
bun test --config=bunfig.int.toml \
  packages/protocol/tests/integration/process-incarnation.test.ts \
  packages/daemon/tests/integration/session/lifecycle/durable-terminal-pane-reap.test.ts
echo "🧪 Proving fy attach accepts the daemon's pane proof on this kernel (the CLI reads the same start identity)..."
bun test --config=bunfig.int.toml packages/cli/tests/integration/reads/tmux-attacher.test.ts
echo "🧪 Proving the file-event hub hears FSEvents on this kernel, dot-files included..."
bun test --config=bunfig.int.toml packages/daemon/tests/integration/file-events/bun-file-event-source.test.ts
echo "🧪 Proving the provisioner's destination steps reach the held folder through descriptor calls on this kernel..."
bun test --config=bunfig.int.toml \
  packages/fleet/tests/integration/descriptor-calls.test.ts \
  packages/fleet/tests/integration/file-provisioner-destination-fence.test.ts
echo "✅ Containment, the process inventory, pane identity, the attach proof, file events and the destination steps hold on $(uname -sm)"
