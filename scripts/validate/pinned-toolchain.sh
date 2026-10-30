#!/usr/bin/env bash
set -euo pipefail

# Fails when `node` or `bun` resolves outside /nix/store.
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

for tool in node bun; do
  path="$(command -v "${tool}" || true)"
  [[ -n ${path} ]] || fail "${tool} is not on PATH; the flake devshell provides it"
  resolved="$(readlink -f "${path}")"
  [[ ${resolved} == /nix/store/* ]] ||
    fail "${tool} resolves to ${resolved}, outside /nix/store: the runner image's ${tool}, not the one the flake pins"
done

echo "✅ node and bun come from /nix/store"
