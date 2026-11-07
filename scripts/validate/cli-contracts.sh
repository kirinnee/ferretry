#!/usr/bin/env bash
set -euo pipefail

contract="${1:-}"
[ -z "${contract}" ] && echo "❌ usage: $0 <contract|all>" >&2 && exit 2

# This is the one registry of the contracts this dispatcher owns. `all` executes it,
# `contract-registry.sh` reads it through `list`, and that gate independently compares it with the
# case arms below. Neither a case nor a registered name can quietly disappear behind a green run.
cli_contracts=(
  arch
  workspace-package-scopes
  name-single-source
  release-backup-order
  changelog-asset
  release-notes-render
  release-artifacts
  homebrew-cask
  installer-checksum
  installer-timeouts
  installation-parity
  release-daemon
  released-version
  nix-packages
)

if [ "${contract}" = "list" ]; then
  printf '%s\n' "${cli_contracts[@]}"
  exit 0
fi

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

cli_pkg="packages/cli"
name="$(jq -r '.bin | to_entries[0].key' "${cli_pkg}/package.json")"
[ -z "${name}" ] || [ "${name}" = "null" ] && echo "❌ no .bin entry in ${cli_pkg}/package.json" >&2 && exit 1
# The daemon is the kernel's host (docs/rebuild/spine.md D1): its executable is the kernel package's first
# `bin` key, exactly as the CLI's is `packages/cli`'s.
daemon_pkg="packages/core/kernel"
daemon_name="$(jq -r '.bin | to_entries[0].key' "${daemon_pkg}/package.json")"
[ -z "${daemon_name}" ] || [ "${daemon_name}" = "null" ] && echo "❌ no .bin entry in ${daemon_pkg}/package.json" >&2 && exit 1
# EVERY executable the daemon package declares — its own and any helper that runs beside it. Each one
# must reach every release channel, or the daemon ships without it.
daemon_bins="$(jq -c '.bin | keys_unsorted' "${daemon_pkg}/package.json")"
product="$(jq -r '.name' package.json)"
[ -z "${product}" ] || [ "${product}" = "null" ] && echo "❌ no name in root package.json" >&2 && exit 1
# Every workspace package, from the root manifest's own `workspaces` globs (a new package is in scope the
# moment it is a workspace; nobody lists it here).
mapfile -t workspace_packages < <(
  jq -r '.workspaces[]' package.json | while IFS= read -r glob; do
    for dir in ${glob}; do [ -f "${dir}/package.json" ] && printf '%s\n' "${dir}"; done
  done | sort -u
)
[ "${#workspace_packages[@]}" -eq 0 ] && echo "❌ no workspace package manifests found under packages/" >&2 && exit 1

if [ "${contract}" = "all" ]; then
  for each in "${cli_contracts[@]}"; do
    "$0" "${each}"
  done
  exit 0
fi

case "${contract}" in
arch)
  entry="$(jq -r '.bin | to_entries[0].value' "${cli_pkg}/package.json")"
  [ ! -f "${cli_pkg}/${entry}" ] && echo "❌ CLI entry is missing: ${cli_pkg}/${entry}" >&2 && exit 1
  daemon_entry="$(jq -r '.bin | to_entries[0].value' "${daemon_pkg}/package.json")"
  [ ! -f "${daemon_pkg}/${daemon_entry}" ] && echo "❌ daemon entry is missing: ${daemon_pkg}/${daemon_entry}" >&2 && exit 1

  # Every `lib/` directory (pure, docs/rebuild/spine.md §3) of every workspace package, at any depth.
  mapfile -t lib_dirs < <(for package_dir in "${workspace_packages[@]}"; do
    find "${package_dir}" -path '*/node_modules' -prune -o -path '*/tests' -prune -o -type d -name lib -print
  done | sort)
  for lib_dir in "${lib_dirs[@]}"; do

    # Enumerate through git rather than letting rg walk the directory: rg skips hidden
    # descendants by default, so a committed src/lib/.probe.ts would bypass this gate.
    lib_files=()
    while IFS= read -r -d '' lib_file; do
      [ -f "${lib_file}" ] && lib_files+=("${lib_file}")
    done < <(git ls-files -z -co --exclude-standard -- "${lib_dir}")
    [ "${#lib_files[@]}" -eq 0 ] && continue

    set +e
    violations="$(rg -n \
      -e '\bconsole\.|\bprocess\.' \
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

    # docs/rebuild/spine.md §2: `@<product>/<dir>` for a top-level package, `@<product>/core-<id>` and
    # `@<product>/plugin-<id>` for a subsystem — except the kernel, which is `@<product>/kernel` (D1).
    package_name="$(basename "${package_dir}")"
    case "${package_dir}" in
    packages/core/kernel) expected="@${product}/kernel" ;;
    packages/core/*) expected="@${product}/core-${package_name}" ;;
    packages/plugins/*) expected="@${product}/plugin-${package_name}" ;;
    *) expected="@${product}/${package_name}" ;;
    esac
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
    rg -qF 'packages/core/kernel' "${script}" || {
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
release-notes-render)
  # The notes configuration must actually list a feature and a fix and drop chores. A preset the
  # notes generator cannot drive renders every release as a bare version header, with no error.
  bun scripts/release/backfill-changelog.ts --check
  ;;
release-artifacts)
  yq -o=json '.' .goreleaser.yaml | jq -e '
    (.archives | length) > 0 and
    (.checksum.name_template | length) > 0 and
    ([.release.extra_files[].glob] | index("scripts/release/install.sh") != null)' >/dev/null
  ;;
homebrew-cask)
  # The cask is named after the PRODUCT, installs every shipped executable, lives in THIS repo
  # (owner repo == project) under Casks/, and strips the quarantine attribute post-install from
  # every executable it installs (an unsigned helper left quarantined is refused by Gatekeeper).
  yq -o=json '.' .goreleaser.yaml | jq -e --arg name "${name}" --argjson daemon "${daemon_bins}" --arg product "${product}" '
    (.homebrew_casks | length) > 0 and
    (.homebrew_casks[0].name == $product) and
    ((.homebrew_casks[0].binaries | sort) == ([$name] + $daemon | sort)) and
    (.homebrew_casks[0].repository.name == .project_name) and
    (.homebrew_casks[0].directory == "Casks") and
    ((.homebrew_casks[0].dependencies // []) | any(.formula == "cloudflared")) and
    ([.homebrew_casks[].hooks.post.install] | join("\n") | contains("com.apple.quarantine")) and
    ([.homebrew_casks[].hooks.post.install] | join("\n") as $hook |
      [$name] + $daemon | all(. as $bin | $hook | contains("/" + $bin + "\"")))' >/dev/null
  # The daemon's tunnel carrier runs cloudflared (docs/relay-protocol.md §15): a dependency the cask
  # installs — in the generator above and the committed cask alike — never a download.
  # GoReleaser writes the dependency as a one-line string or, beside other formulae, a multi-line array.
  rg -Uq 'depends_on formula: (\[\s*("[^"]*",\s*)*)?"cloudflared"' "Casks/${product}.rb"
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
  # The commands the setup docs promise are in a fenced block of INSTALLATION.md. (In 4.x the public
  # /get-started page was also held to them line by line; that page moves into the Onboarding plugin, and the
  # page half of this check returns with its port.)
  doc_lines="$(awk '/^ *```/ { fenced = !fenced; next } fenced { sub(/^ +/, ""); print }' INSTALLATION.md)"
  for command in "${name} setup" "${name} setup --check" "${name} daemon status" "${name} pair" "${name} pair --no-wait" "${name} pair --open --no-wait"; do
    grep -qxF -- "${command}" <<<"${doc_lines}" || {
      echo "❌ INSTALLATION.md: command not in a fenced block: ${command}" >&2
      exit 1
    }
  done
  ;;
release-daemon)
  # A release archive, package, and cask must carry EVERY independently declared executable: the CLI,
  # the daemon, and each helper the daemon package declares beside it (its browser worker). Check the
  # build IDs transitively so listing a build without distributing it still fails.
  yq -o=json '.' .goreleaser.yaml | jq -e --arg cli "${name}" --argjson daemon "${daemon_bins}" '
    (.archives[0].ids as $archive_ids |
      ([.builds[] | select(.id as $id | $archive_ids | index($id)) | .binary] | sort == ([$cli] + $daemon | sort))) and
    (.nfpms[0].ids as $package_ids |
      ([.builds[] | select(.id as $id | $package_ids | index($id)) | .binary] | sort == ([$cli] + $daemon | sort))) and
    ((.homebrew_casks[0].binaries | sort) == ([$cli] + $daemon | sort))' >/dev/null
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
