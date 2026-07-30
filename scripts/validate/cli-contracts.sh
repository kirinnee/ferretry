#!/usr/bin/env bash
set -euo pipefail

contract="${1:-}"
[ -z "${contract}" ] && echo "❌ usage: $0 <contract|all>" >&2 && exit 2

cli_pkg="packages/cli"
name="$(jq -r '.bin | to_entries[0].key' "${cli_pkg}/package.json")"
[ -z "${name}" ] || [ "${name}" = "null" ] && echo "❌ no .bin entry in ${cli_pkg}/package.json" >&2 && exit 1
product="$(jq -r '.name' package.json)"
[ -z "${product}" ] || [ "${product}" = "null" ] && echo "❌ no name in root package.json" >&2 && exit 1

if [ "${contract}" = "all" ]; then
  for each in arch name-single-source release-backup-order changelog-asset release-artifacts homebrew-cask installer-checksum installer-timeouts installation-parity; do
    "$0" "${each}"
  done
  exit 0
fi

case "${contract}" in
arch)
  entry="$(jq -r '.bin | to_entries[0].value' "${cli_pkg}/package.json")"
  test -f "${cli_pkg}/${entry}"
  test -f "${cli_pkg}/src/adapters/terminal/console-io.ts"
  rg -q 'console\.|process\.(stdin|stdout|stderr|exitCode)|from .(chalk|ora|cli-progress|inquirer).' "${cli_pkg}/src/lib" && echo '❌ terminal/shell IO leaked into src/lib' >&2 && exit 1
  rg -q "from ['\"](\\.\\./)+adapters(?:/|['\"])" "${cli_pkg}/src/lib" && echo '❌ src/lib imports an adapter (forbidden upward dependency)' >&2 && exit 1
  ;;
name-single-source)
  # Derivation rule: scripts and Taskfiles must read the binary name from the bin key, never hardcode it.
  rg -qF ".bin | to_entries[0].key" Taskfile.yaml
  for script in scripts/release/compile.sh scripts/release/goreleaser-shim.sh scripts/release/smoke.sh; do
    rg -qF ".bin | to_entries[0].key" "${script}" || {
      echo "❌ ${script} does not derive the CLI name from the bin key" >&2
      exit 1
    }
  done
  # Two-name model: static PRODUCT-bearing files agree with the root package.json name, and
  # static BINARY-bearing files agree with the bin key (rename.sh keeps both in sync).
  rg -qF "project_name: ${product}" .goreleaser.yaml
  test -f "Casks/${product}.rb"
  rg -qF "module ${product}" go.mod
  rg -qF "REPO=\"kirinnee/${product}\"" scripts/release/install.sh
  rg -qF "binary: ${name}" .goreleaser.yaml
  rg -qF "binary \"${name}\"" "Casks/${product}.rb"
  rg -qF "BINARY=\"${name}\"" scripts/release/install.sh
  ;;
release-backup-order)
  yq -o=json '.' .releaserc.yaml | jq -e '
    ([.plugins[] | select(type == "array" and .[0] == "@semantic-release/exec")][0][1].prepareCmd
      == "./scripts/release/backup-changelog.sh") and
    ([.plugins[] | if type == "array" then .[0] else . end] | index("@semantic-release/github") == null)' >/dev/null
  ;;
changelog-asset)
  yq -o=json '.' .releaserc.yaml | jq -e '
    [.plugins[] | select(type == "array" and .[0] == "@semantic-release/git") | .[1].assets[]] |
    index("Changelog.old.md") != null' >/dev/null
  rg -qF -- '--release-notes ./IncrementalChangelog.md' scripts/release/publish.sh
  ;;
release-artifacts)
  yq -o=json '.' .goreleaser.yaml | jq -e '
    (.archives | length) > 0 and
    (.checksum.name_template | length) > 0 and
    ([.release.extra_files[].glob] | index("scripts/release/install.sh") != null)' >/dev/null
  ;;
homebrew-cask)
  # The cask is named after the PRODUCT, installs the BINARY, lives in THIS repo (owner repo ==
  # project) under Casks/, and strips the quarantine attribute post-install.
  yq -o=json '.' .goreleaser.yaml | jq -e --arg name "${name}" --arg product "${product}" '
    (.homebrew_casks | length) > 0 and
    (.homebrew_casks[0].name == $product) and
    (.homebrew_casks[0].binaries == [$name]) and
    (.homebrew_casks[0].repository.name == .project_name) and
    (.homebrew_casks[0].directory == "Casks") and
    ([.homebrew_casks[].hooks.post.install] | join("\n") | contains("com.apple.quarantine"))' >/dev/null
  ;;
installer-checksum)
  rg -qF 'checksums.txt' scripts/release/install.sh
  rg -q 'sha256sum -c|shasum -a 256' scripts/release/install.sh
  ;;
installer-timeouts)
  curl_lines="$(rg '^[[:space:]]*curl ' scripts/release)"
  [ -z "${curl_lines}" ] && echo "❌ no release curl commands found" >&2 && exit 1
  bad_lines="$(printf '%s\n' "${curl_lines}" | awk '!/--connect-timeout/ || !/--max-time/')"
  [ -n "${bad_lines}" ] && printf '❌ curl missing timeout guard:\n%s\n' "${bad_lines}" >&2 && exit 1
  ;;
installation-parity)
  # Archives are named after the BINARY (the archive template, installer, and docs must agree).
  rg -qF 'scripts/release/install.sh' .goreleaser.yaml
  rg -qF "name_template: '${name}_{{ .Os }}_{{ .Arch }}'" .goreleaser.yaml
  rg -qF 'checksums.txt' .goreleaser.yaml
  rg -qF "${name}_<os>_<arch>.tar.gz" INSTALLATION.md
  ;;
*)
  echo "❌ unknown CLI contract: ${contract}" >&2
  exit 2
  ;;
esac

echo "✅ CLI contract passed: ${contract}"
