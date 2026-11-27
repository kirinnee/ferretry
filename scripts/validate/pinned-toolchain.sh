#!/usr/bin/env bash
set -euo pipefail

# Fails when `node`, `bun` or `tmux` resolves outside /nix/store (and, on Linux, when the shell carries no fonts
# configuration for the browser tests), and prints the version of each.
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

# fonts (Linux): Chrome in the visual and browser tiers finds fonts through fontconfig. A host with none gives it an empty
# font set, so every unit-free "does this label fit" measurement is wrong and Chromium needs a hand-made config before
# it renders text at all. The devshell hands it one (nix/shells.nix): a file in /nix/store that names a font directory.
if [[ "$(uname -s)" == Linux ]]; then
  fonts="${FONTCONFIG_FILE:-}"
  [[ -n ${fonts} && ${fonts} == /nix/store/* && -r ${fonts} ]] ||
    fail "FONTCONFIG_FILE is ${fonts:-unset}, not a fonts configuration from /nix/store: Chrome would draw no text"
  grep -q '<dir>/nix/store/.*dejavu' "${fonts}" ||
    fail "FONTCONFIG_FILE (${fonts}) names no DejaVu font directory, so Chrome would have no font to draw with"
fi

echo "✅ node $(node --version), bun $(bun --version) and $(tmux -V) come from /nix/store"
