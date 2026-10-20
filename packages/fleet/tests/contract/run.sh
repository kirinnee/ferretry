#!/usr/bin/env bash
# The harness contract guard (design §8.5): measure the mechanisms the account model relies on
# against a real `claude` and `codex`, with fake credentials and no network.
#
#   run.sh pinned   the versions this build ships with: claude-code and codex from the flake's own
#                   locked nixpkgs (`--inputs-from`), so the pin moves only when flake.lock does.
#   run.sh latest   the newest published npm releases, run on a schedule so a breaking release is
#                   seen before the pin reaches it.
#
# Every test file skips unless FY_HARNESS_CONTRACT=1, which only this script sets. Results, with the
# exact versions measured, are written to $FY_CONTRACT_ARTIFACTS (default: a temporary directory).
set -euo pipefail

mode="${1:-pinned}"
[[ ${mode} != "pinned" && ${mode} != "latest" ]] && echo "❌ usage: $0 <pinned|latest>" >&2 && exit 2

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"
artifacts="${FY_CONTRACT_ARTIFACTS:-$(mktemp -d)}"
mkdir -p "${artifacts}"

./scripts/ci/setup.sh

# The guard's own TLS stand-in needs openssl; take it from the same locked nixpkgs so a runner's
# LibreSSL (macOS) cannot change what is measured.
openssl_out="$(nix build --inputs-from . nixpkgs#openssl.bin --no-link --print-out-paths)"
export FY_CONTRACT_OPENSSL="${openssl_out}/bin/openssl"
FY_CONTRACT_RG="$(command -v rg)"
export FY_CONTRACT_RG

if [[ ${mode} == "pinned" ]]; then
  # claude-code is unfree, so its evaluation needs the explicit allowance (and --impure to read it).
  claude_root="$(NIXPKGS_ALLOW_UNFREE=1 nix build --impure --inputs-from . nixpkgs#claude-code --no-link --print-out-paths)"
  codex_root="$(nix build --inputs-from . nixpkgs#codex --no-link --print-out-paths)"
  export FY_CONTRACT_CLAUDE_BIN="${claude_root}/bin/claude"
  export FY_CONTRACT_CODEX_BIN="${codex_root}/bin/codex"
  export FY_CONTRACT_CLAUDE_ROOT="${claude_root}"
  export FY_CONTRACT_CODEX_ROOT="${codex_root}"
else
  command -v npm >/dev/null || {
    echo "❌ latest mode installs from npm, and npm is not on PATH" >&2
    exit 1
  }
  prefix="$(mktemp -d)"
  trap 'rm -rf "${prefix}"' EXIT
  npm install --prefix "${prefix}" --no-audit --no-fund --loglevel=error \
    @anthropic-ai/claude-code@latest @openai/codex@latest
  export FY_CONTRACT_CLAUDE_BIN="${prefix}/node_modules/.bin/claude"
  export FY_CONTRACT_CODEX_BIN="${prefix}/node_modules/.bin/codex"
  export FY_CONTRACT_CLAUDE_ROOT="${prefix}/node_modules"
  export FY_CONTRACT_CODEX_ROOT="${prefix}/node_modules"
  # An npm launcher may be a `node` script; the harness's minimal PATH has to be able to find it.
  FY_CONTRACT_PATH="$(dirname "$(command -v node)"):/usr/bin:/bin"
  export FY_CONTRACT_PATH
fi

for bin in "${FY_CONTRACT_CLAUDE_BIN}" "${FY_CONTRACT_CODEX_BIN}"; do
  [[ -x ${bin} ]] || {
    echo "❌ harness binary missing or not executable: ${bin}" >&2
    exit 1
  }
done

version_of() {
  env -i HOME="$(mktemp -d)" PATH="${FY_CONTRACT_PATH:-/usr/bin:/bin}" "$1" --version 2>/dev/null | head -n 1
}
claude_version="$(version_of "${FY_CONTRACT_CLAUDE_BIN}")"
codex_version="$(version_of "${FY_CONTRACT_CODEX_BIN}")"
echo "🔎 harness contract (${mode}, $(uname -s)): claude ${claude_version} · codex ${codex_version}"

# The pinned versions ARE what Ferretry calls "verified" (VERIFIED_HARNESS_VERSIONS, docs/updating.md):
# the app warns before an update goes past them. A flake.lock bump that moves the pin must move that
# constant in the same change, so a mismatch fails here rather than mislabelling every machine.
if [[ ${mode} == "pinned" ]]; then
  semver_of() { grep -oE '[0-9]+\.[0-9]+\.[0-9]+' <<<"$1" | head -n 1; }
  verified="$(bun -e "import { VERIFIED_HARNESS_VERSIONS as v } from './packages/protocol/src/lib/harness-update.ts'; console.log(v.claude + ' ' + v.codex);")"
  read -r verified_claude verified_codex <<<"${verified}"
  if [[ "$(semver_of "${claude_version}")" != "${verified_claude}" || "$(semver_of "${codex_version}")" != "${verified_codex}" ]]; then
    echo "❌ the pin measures claude $(semver_of "${claude_version}") · codex $(semver_of "${codex_version}"), but VERIFIED_HARNESS_VERSIONS says claude ${verified_claude} · codex ${verified_codex}; update packages/protocol/src/lib/harness-update.ts with the pin" >&2
    exit 1
  fi
fi

export FY_HARNESS_CONTRACT=1
set +e
bun test --timeout 180000 ./packages/fleet/tests/contract/ 2>&1 | tee "${artifacts}/bun-test.log"
status="${PIPESTATUS[0]}"
set -e

jq -n --arg mode "${mode}" --arg os "$(uname -s)" --arg arch "$(uname -m)" \
  --arg claude "${claude_version}" --arg codex "${codex_version}" --argjson passed "$([[ ${status} -eq 0 ]] && echo true || echo false)" \
  '{mode: $mode, os: $os, arch: $arch, claude: $claude, codex: $codex, passed: $passed}' >"${artifacts}/result.json"
cat "${artifacts}/result.json"

if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  {
    echo "### Harness contract (${mode}, $(uname -s) $(uname -m))"
    echo ""
    echo "- claude: \`${claude_version}\`"
    echo "- codex: \`${codex_version}\`"
    echo "- result: $([[ ${status} -eq 0 ]] && echo 'passed' || echo '**FAILED** — a mechanism the account model relies on broke; see design §9.5')"
  } >>"${GITHUB_STEP_SUMMARY}"
fi

[[ ${status} -eq 0 ]] && echo "✅ harness contract held" || echo "❌ harness contract broken" >&2
exit "${status}"
