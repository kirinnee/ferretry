#!/usr/bin/env bash
set -euo pipefail

contract="${1:-}"
[ -z "${contract}" ] && echo "❌ usage: $0 <contract|all>" >&2 && exit 2

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

cli_pkg="packages/cli"
name="$(jq -r '.bin | to_entries[0].key' "${cli_pkg}/package.json")"
[ -z "${name}" ] || [ "${name}" = "null" ] && echo "❌ no .bin entry in ${cli_pkg}/package.json" >&2 && exit 1
daemon_pkg="packages/daemon"
daemon_name="$(jq -r '.bin | to_entries[0].key' "${daemon_pkg}/package.json")"
[ -z "${daemon_name}" ] || [ "${daemon_name}" = "null" ] && echo "❌ no .bin entry in ${daemon_pkg}/package.json" >&2 && exit 1
product="$(jq -r '.name' package.json)"
[ -z "${product}" ] || [ "${product}" = "null" ] && echo "❌ no name in root package.json" >&2 && exit 1
mapfile -t workspace_packages < <(find packages -mindepth 2 -maxdepth 2 -name package.json -printf '%h\n' | sort)
[ "${#workspace_packages[@]}" -eq 0 ] && echo "❌ no workspace package manifests found under packages/" >&2 && exit 1

if [ "${contract}" = "all" ]; then
  for each in arch workspace-package-scopes name-single-source release-backup-order changelog-asset release-artifacts homebrew-cask installer-checksum installer-timeouts installation-parity release-daemon nix-packages; do
    "$0" "${each}"
  done
  exit 0
fi

case "${contract}" in
arch)
  entry="$(jq -r '.bin | to_entries[0].value' "${cli_pkg}/package.json")"
  [ ! -f "${cli_pkg}/${entry}" ] && echo "❌ CLI entry is missing: ${cli_pkg}/${entry}" >&2 && exit 1
  [ ! -f "${cli_pkg}/src/adapters/terminal/console-io.ts" ] && echo "❌ CLI terminal adapter is missing" >&2 && exit 1

  for package_dir in "${workspace_packages[@]}"; do
    lib_dir="${package_dir}/src/lib"
    [ ! -d "${lib_dir}" ] && continue

    # Enumerate through git rather than letting rg walk the directory: rg skips hidden
    # descendants by default, so a committed src/lib/.probe.ts would bypass this gate.
    lib_files=()
    while IFS= read -r -d '' lib_file; do
      [ -f "${lib_file}" ] && lib_files+=("${lib_file}")
    done < <(git ls-files -z -co --exclude-standard -- "${lib_dir}")
    [ "${#lib_files[@]}" -eq 0 ] && continue

    set +e
    violations="$(rg -n \
      -e 'console\.|process\.' \
      -e "(from|import|require)[^\"']*[\"'](chalk|ora|cli-progress|inquirer)(/[^\"']*)?[\"']" \
      -e "(from|import|require)[^\"']*[\"'](\.[^\"']*/)?adapters(/[^\"']*)?[\"']" \
      -- "${lib_files[@]}")"
    scan_status=$?
    set -e

    if [ "${scan_status}" -eq 0 ]; then
      echo "❌ ${lib_dir} contains forbidden IO, terminal dependencies, or adapter imports:" >&2
      printf '%s\n' "${violations}" >&2
      exit 1
    fi
    [ "${scan_status}" -gt 1 ] && echo "❌ failed to scan ${lib_dir}" >&2 && exit "${scan_status}"
  done
  ;;
workspace-package-scopes)
  for package_dir in "${workspace_packages[@]}"; do
    actual="$(jq -r '.name' "${package_dir}/package.json")"
    if [ "${package_dir}" = "${cli_pkg}" ]; then
      [ "${actual}" != "${name}" ] && echo "❌ ${cli_pkg}/package.json name must match its bin key '${name}', got '${actual}'" >&2 && exit 1
      continue
    fi

    package_name="$(basename "${package_dir}")"
    expected="@${product}/${package_name}"
    [ "${actual}" != "${expected}" ] && echo "❌ ${package_dir}/package.json name must be '${expected}', got '${actual}'" >&2 && exit 1
  done
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
  for script in scripts/release/compile.sh scripts/release/goreleaser-shim.sh; do
    rg -qF 'packages/daemon' "${script}" || {
      echo "❌ ${script} does not derive the daemon name from its bin key" >&2
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
  rg -qF "package_name: ${name}" .goreleaser.yaml
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
  # The cask is named after the PRODUCT, installs both shipped executables, lives in THIS repo
  # (owner repo == project) under Casks/, and strips the quarantine attribute post-install.
  yq -o=json '.' .goreleaser.yaml | jq -e --arg name "${name}" --arg daemon "${daemon_name}" --arg product "${product}" '
    (.homebrew_casks | length) > 0 and
    (.homebrew_casks[0].name == $product) and
    ((.homebrew_casks[0].binaries | sort) == ([$name, $daemon] | sort)) and
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
  # Linux packages: nfpms builds deb+rpm named after the BINARY, the fury pusher and the
  # documented apt/yum repositories point at the same Gemfury account.
  yq -o=json '.' .goreleaser.yaml | jq -e --arg name "${name}" '
    (.nfpms | length) > 0 and
    (.nfpms[0].package_name == $name) and
    (.nfpms[0].file_name_template == "{{ .PackageName }}_{{ .Version }}_{{ .Os }}_{{ .Arch }}") and
    ((.nfpms[0].formats | sort) == ["deb", "rpm"])' >/dev/null
  # The account is kirinnee97. It was kirinnee here and in fury.sh until 2026-08-03, which is why
  # every release since the channel was added returned `403 account access denied`: the token
  # authenticated fine and then pushed at an account it does not own. The three literals below must
  # keep naming ONE account — an installer pointed at a repository the release never publishes to is
  # the same defect wearing different clothes.
  rg -qF 'endpoint="push.fury.io/kirinnee97"' scripts/release/fury.sh
  rg -qF './scripts/release/fury.sh' scripts/release/publish.sh
  rg -qF 'deb [trusted=yes] https://apt.fury.io/kirinnee97/ /' INSTALLATION.md
  rg -qF 'https://yum.fury.io/kirinnee97/' INSTALLATION.md
  rg -qF "apt install ${name}" INSTALLATION.md
  rg -qF "dnf install ${name}" INSTALLATION.md
  ;;
release-daemon)
  # A release archive, package, and cask must carry BOTH independently declared executables.
  # Check the build IDs transitively so listing a daemon build without distributing it still fails.
  yq -o=json '.' .goreleaser.yaml | jq -e --arg cli "${name}" --arg daemon "${daemon_name}" '
    (.archives[0].ids as $archive_ids |
      ([.builds[] | select(.id as $id | $archive_ids | index($id)) | .binary] | sort == ([$cli, $daemon] | sort))) and
    (.nfpms[0].ids as $package_ids |
      ([.builds[] | select(.id as $id | $package_ids | index($id)) | .binary] | sort == ([$cli, $daemon] | sort))) and
    ((.homebrew_casks[0].binaries | sort) == ([$cli, $daemon] | sort))' >/dev/null
  # The installer intentionally derives install names from verified archive contents. Requiring two
  # executable files stops a CLI-only archive from being reported as a complete normal install.
  rg -qF 'for artifact in "${contents}"/*; do' scripts/release/install.sh
  rg -qF '[ "${#installed[@]}" -ge 2 ]' scripts/release/install.sh
  ;;
nix-packages)
  # Nix's default package is the normal profile-install entry point. It must join the independently
  # built CLI and daemon, and flake check must build that bundle instead of merely evaluating it.
  test -f nix/ferretry.nix
  rg -qF 'inherit fy fyd;' nix/ferretry.nix
  rg -q -U 'paths = \[\s*\n\s*fy\s*\n\s*fyd\s*\n\s*\];' nix/ferretry.nix
  rg -qF 'release-bundle = releasePackages.default;' flake.nix
  rg -qF 'program = "${releasePackages.default}/bin/fy";' flake.nix
  ;;
*)
  echo "❌ unknown CLI contract: ${contract}" >&2
  exit 2
  ;;
esac

echo "✅ Contract passed: ${contract}"
