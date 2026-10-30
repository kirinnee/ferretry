#!/usr/bin/env bash
set -euo pipefail

# Fails when `node`, `bun` or `tmux` resolves outside /nix/store, and prints the version of each.
#
# The flake pins the toolchain, but PATH decides which binary a script actually runs. The `vite`
# bin is `#!/usr/bin/env node`, so with no pinned Node in the devshell the PWA build ran on whatever
# Node the runner image shipped: green on GitHub's image, `ERR_UNKNOWN_FILE_EXTENSION` for a `.ts`
# import on a Namespace image whose Node cannot strip types. Run from inside `nix develop`; a
# binary the flake did not provide is a build that is not reproducible.

fail() {
  echo "❌ $1" >&2
  echo '   Run inside the pinned shell: nix develop .#ci -c <command>, or direnv. The flake provides it.' >&2
  exit 1
}

# tmux: the integration tier drives a real one, and a runner image's tmux is a different program on
# every image (3.6a on Ubuntu, 3.8 from Homebrew) with its own races — see nix/env.nix.
for tool in node bun tmux; do
  path="$(command -v "${tool}" || true)"
  [[ -n ${path} ]] || fail "${tool} is not on PATH; the flake devshell provides it"
  resolved="$(readlink -f "${path}")"
  [[ ${resolved} == /nix/store/* ]] ||
    fail "${tool} resolves to ${resolved}, outside /nix/store: the runner image's ${tool}, not the one the flake pins"
done

echo "✅ node $(node --version), bun $(bun --version) and $(tmux -V) come from /nix/store"
