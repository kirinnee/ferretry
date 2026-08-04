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
# nothing about containment.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

./scripts/ci/setup.sh

echo "🧪 Proving descriptor containment on $(uname -sm)..."
bun test --config=bunfig.int.toml packages/daemon/tests/integration/session/filesystem/
echo "✅ Containment holds on $(uname -sm)"
