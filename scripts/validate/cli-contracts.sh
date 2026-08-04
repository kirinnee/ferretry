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
  for each in arch workspace-package-scopes name-single-source daemon-default-address state-home-log-directory release-backup-order changelog-asset release-artifacts homebrew-cask installer-checksum installer-timeouts installation-parity release-daemon released-version nix-packages; do
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
state-home-log-directory)
  # The CLI creates `<state home>/logs` before it launches the daemon, so the daemon's very first
  # boot on a clean machine always meets a home holding that directory and nothing else. The layout
  # model has to know the directory is ours: when it did not, it classified our own log directory as
  # somebody else's data and refused to bootstrap ANY fresh machine — and wrote the refusal into the
  # log file inside the directory that caused it.
  #
  # The two packages derive the name independently, because `packages/cli` does not depend on
  # `@ferretry/daemon` and must not start to for one string. This is where they are held to one word.
  cli_layout="${cli_pkg}/src/lib/daemon/layout.ts"
  daemon_paths="${daemon_pkg}/src/lib/paths.ts"
  daemon_layout="${daemon_pkg}/src/adapters/storage/state-home-layout.ts"

  cli_logs="$(rg -o -r '$1' "logDirectory = join\(stateHome, '([^']+)'\)" "${cli_layout}")"
  [ -z "${cli_logs}" ] && echo "❌ ${cli_layout} no longer derives a log directory under the state home" >&2 && exit 1
  daemon_logs="$(rg -o -r '$1' "logs: join\(home, '([^']+)'\)" "${daemon_paths}")"
  [ -z "${daemon_logs}" ] && echo "❌ ${daemon_paths} does not name a log directory in FoundationPaths" >&2 && exit 1
  [ "${cli_logs}" != "${daemon_logs}" ] &&
    echo "❌ the CLI creates '<state home>/${cli_logs}' but the daemon layout declares '${daemon_logs}'" >&2 && exit 1

  rg -A4 'export function requiredLayoutDirectories' "${daemon_paths}" | rg -qF 'paths.logs' || {
    echo "❌ ${daemon_paths} does not require the log directory, so bootstrap would not create it" >&2
    exit 1
  }
  rg -qF 'paths.logs' "${daemon_layout}" || {
    echo "❌ ${daemon_layout} does not admit the log directory, so a fresh home would refuse to bootstrap" >&2
    exit 1
  }
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
released-version)
  # Both shipped executables stamp their own manifest version into what they report — the CLI's
  # `--version`, the daemon's `/v1/health` and its version header — so a release that bumped only one
  # of them shipped a daemon claiming 0.0.0. The bump script and the release assets must carry both,
  # and the manifests must already agree with the released version in the tree.
  released="$(cat VERSION)"
  for package_dir in "${cli_pkg}" "${daemon_pkg}"; do
    stamped="$(jq -r '.version' "${package_dir}/package.json")"
    [ "${stamped}" != "${released}" ] &&
      echo "❌ ${package_dir}/package.json is ${stamped} but VERSION is ${released}" >&2 && exit 1
    rg -qF "${package_dir}" scripts/release/bump.sh || {
      echo "❌ scripts/release/bump.sh does not stamp ${package_dir}" >&2
      exit 1
    }
    rg -qF -e "- ${package_dir}/package.json" .releaserc.yaml || {
      echo "❌ .releaserc.yaml does not commit ${package_dir}/package.json with the release" >&2
      exit 1
    }
  done
  ;;
daemon-default-address)
  # The well-known loopback address three production files must agree on. They live in packages that
  # may not import one another, so it is single-sourced in the protocol package and every other
  # production file derives it. A second copy fails SILENTLY — the client probes an address nothing
  # holds and reports the daemon down while it serves one port away — so the literal is pinned here
  # exactly as the two-name model is.
  address_source="packages/protocol/src/lib/address.ts"
  test -f "${address_source}"
  port="$(rg -o -r '$1' 'FY_DEFAULT_DAEMON_PORT = ([0-9]+)' "${address_source}")"
  [ -z "${port}" ] && echo "❌ ${address_source} does not declare FY_DEFAULT_DAEMON_PORT" >&2 && exit 1
  production_files=()
  while IFS= read -r -d '' path; do
    [ "${path}" = "${address_source}" ] && continue
    case "${path}" in
    */src/* | */bin/*) production_files+=("${path}") ;;
    esac
  done < <(git ls-files -z -co --exclude-standard -- packages)
  if [ "${#production_files[@]}" -gt 0 ]; then
    set +e
    strays="$(rg --line-number --fixed-strings -- "${port}" "${production_files[@]}")"
    stray_status=$?
    set -e
    if [ "${stray_status}" -eq 0 ]; then
      echo "❌ the default daemon port is written out instead of imported from ${address_source}:" >&2
      printf '%s\n' "${strays}" >&2
      exit 1
    fi
    [ "${stray_status}" -gt 1 ] && echo "❌ failed to scan package source for the default port" >&2 && exit "${stray_status}"
  fi
  # And the two consumers must actually read the single source rather than each other.
  rg -qF 'FY_DEFAULT_DAEMON_PORT' packages/daemon/src/lib/runtime/config.ts || {
    echo "❌ the daemon's configuration default does not read FY_DEFAULT_DAEMON_PORT" >&2
    exit 1
  }
  rg -qF 'FY_DEFAULT_DAEMON_URL' packages/cli/src/lib/daemon/address.ts || {
    echo "❌ the CLI's address resolution does not read FY_DEFAULT_DAEMON_URL" >&2
    exit 1
  }
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
