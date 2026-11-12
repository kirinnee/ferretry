#!/usr/bin/env bash
# The Codex credential-link contract guard: measure the mechanism a ferret's linked auth.json relies on against a real
# `codex`, with fake credentials and no network (ported from v4's fleet/tests/contract/run.sh, Codex half).
#
#   run.sh pinned   the codex from the flake's own locked nixpkgs (`--inputs-from`), so the pin moves only when
#                   flake.lock does.
#   run.sh latest   the newest published npm release, for a schedule that sees a breaking release before the pin reaches it.
#   run.sh path     the `codex` already on PATH (a developer's machine; says which version it measured).
#
# The test skips unless FY_HARNESS_CONTRACT=1, which only this script sets.
set -euo pipefail

mode="${1:-pinned}"
[[ ${mode} != "pinned" && ${mode} != "latest" && ${mode} != "path" ]] && echo "❌ usage: $0 <pinned|latest|path>" >&2 && exit 2

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

case "${mode}" in
pinned)
  codex_root="$(nix build --inputs-from . nixpkgs#codex --no-link --print-out-paths)"
  export FY_CONTRACT_CODEX_BIN="${codex_root}/bin/codex"
  export FY_CONTRACT_CODEX_ROOT="${codex_root}"
  ;;
latest)
  command -v npm >/dev/null || {
    echo "❌ latest mode installs from npm, and npm is not on PATH" >&2
    exit 1
  }
  prefix="$(mktemp -d)"
  trap 'rm -rf "${prefix}"' EXIT
  npm install --prefix "${prefix}" --no-audit --no-fund --loglevel=error @openai/codex@latest
  export FY_CONTRACT_CODEX_BIN="${prefix}/node_modules/.bin/codex"
  export FY_CONTRACT_CODEX_ROOT="${prefix}/node_modules"
  # An npm launcher may be a `node` script; the harness's minimal PATH has to be able to find it.
  FY_CONTRACT_PATH="$(dirname "$(command -v node)"):/usr/bin:/bin"
  export FY_CONTRACT_PATH
  ;;
path)
  FY_CONTRACT_CODEX_BIN="$(command -v codex)" || {
    echo "❌ path mode needs a codex on PATH" >&2
    exit 1
  }
  export FY_CONTRACT_CODEX_BIN
  # The tree searched for the strings the design depends on is the installed package, not the PATH directory of links.
  FY_CONTRACT_CODEX_ROOT="$(dirname "$(dirname "$(readlink -f "${FY_CONTRACT_CODEX_BIN}")")")"
  export FY_CONTRACT_CODEX_ROOT
  # A launcher on PATH may be a `node` script or a nix wrapper: keep its own directory reachable.
  FY_CONTRACT_PATH="$(dirname "${FY_CONTRACT_CODEX_BIN}"):/usr/bin:/bin"
  export FY_CONTRACT_PATH
  ;;
esac

[[ -x ${FY_CONTRACT_CODEX_BIN} ]] || {
  echo "❌ codex missing or not executable: ${FY_CONTRACT_CODEX_BIN}" >&2
  exit 1
}
FY_CONTRACT_RG="$(command -v rg)"
export FY_CONTRACT_RG

codex_version="$(env -i HOME="$(mktemp -d)" PATH="${FY_CONTRACT_PATH:-/usr/bin:/bin}" "${FY_CONTRACT_CODEX_BIN}" --version 2>/dev/null | head -n 1)"
echo "🔎 codex credential-link contract (${mode}, $(uname -s)): ${codex_version}"

export FY_HARNESS_CONTRACT=1
set +e
bun test --timeout 180000 ./packages/plugins/logins/tests/realworld/contract/ 2>&1
status="$?"
set -e

[[ ${status} -eq 0 ]] && echo "✅ codex credential-link contract held (${codex_version})" || echo "❌ codex credential-link contract broken (${codex_version})" >&2
exit "${status}"
