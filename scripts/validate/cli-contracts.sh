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
  daemon-default-address
  loopback-single-source
  pairing-fragment-readers
  state-home-log-directory
  state-home-layout-claim
  state-home-default
  release-backup-order
  changelog-asset
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
daemon_pkg="packages/daemon"
daemon_name="$(jq -r '.bin | to_entries[0].key' "${daemon_pkg}/package.json")"
[ -z "${daemon_name}" ] || [ "${daemon_name}" = "null" ] && echo "❌ no .bin entry in ${daemon_pkg}/package.json" >&2 && exit 1
product="$(jq -r '.name' package.json)"
[ -z "${product}" ] || [ "${product}" = "null" ] && echo "❌ no name in root package.json" >&2 && exit 1
mapfile -t workspace_packages < <(find packages -mindepth 2 -maxdepth 2 -name package.json -printf '%h\n' | sort)
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
state-home-layout-claim)
  # THE SECOND INSTANCE OF THE `state-home-log-directory` BUG, pinned the same way its first was.
  #
  # Creating state in a home and CLAIMING that home have to be one operation. They were two, so
  # `fy fleet init` wrote `<FY_HOME>/fleet/**` without a marker and manufactured exactly the
  # arrangement the daemon must refuse — a non-empty directory that might be somebody else's. The
  # daemon then declined to boot FOREVER, and the only move the shipped product left an owner was to
  # delete the installation they had just provisioned. Run the two commands the other way round and
  # everything worked.
  #
  # So the decision, the marker's name, its bytes and its mode are single-sourced in the protocol
  # package — the one thing both writers already depend on, since neither may import the other. A
  # second copy fails SILENTLY in the worst way: a daemon looking for one filename while its client
  # writes another refuses the very home its client just claimed, and neither end explains why.
  layout_source="packages/protocol/src/lib/state-home-layout.ts"
  test -f "${layout_source}"
  marker_name="$(rg -o -r '$1' "LAYOUT_VERSION_FILENAME = '([^']+)'" "${layout_source}")"
  [ -z "${marker_name}" ] && echo "❌ ${layout_source} does not declare LAYOUT_VERSION_FILENAME" >&2 && exit 1
  layout_version="$(rg -o -r '$1' 'CURRENT_LAYOUT_VERSION = ([0-9]+)' "${layout_source}")"
  [ -z "${layout_version}" ] && echo "❌ ${layout_source} does not declare CURRENT_LAYOUT_VERSION" >&2 && exit 1

  # Neither package may carry its own copy of either literal. Tests are excluded: an assertion has to
  # be able to spell the value it expects, or it is asserting the implementation against itself.
  claim_files=()
  while IFS= read -r -d '' path; do
    [ "${path}" = "${layout_source}" ] && continue
    case "${path}" in
    */src/* | */bin/*) claim_files+=("${path}") ;;
    esac
  done < <(git ls-files -z -co --exclude-standard -- packages/cli packages/daemon)
  if [ "${#claim_files[@]}" -gt 0 ]; then
    set +e
    strays="$(rg --line-number --fixed-strings -- "'${marker_name}'" "${claim_files[@]}")"
    stray_status=$?
    set -e
    if [ "${stray_status}" -eq 0 ]; then
      echo "❌ the layout marker filename is written out instead of imported from ${layout_source}:" >&2
      printf '%s\n' "${strays}" >&2
      exit 1
    fi
    [ "${stray_status}" -gt 1 ] && echo "❌ failed to scan package source for the marker filename" >&2 && exit "${stray_status}"
  fi

  # And both writers must actually read the single source rather than each other.
  rg -qF '@ferretry/protocol' "${daemon_pkg}/src/lib/layout.ts" || {
    echo "❌ ${daemon_pkg}/src/lib/layout.ts does not read the layout decision from the protocol package" >&2
    exit 1
  }
  rg -qF 'LAYOUT_VERSION_FILENAME' "${daemon_pkg}/src/lib/paths.ts" || {
    echo "❌ ${daemon_pkg}/src/lib/paths.ts does not derive the marker path from the shared filename" >&2
    exit 1
  }
  cli_claim="${cli_pkg}/src/lib/state-home/claim.ts"
  [ ! -f "${cli_claim}" ] && echo "❌ the CLI has no state-home claim: ${cli_claim}" >&2 && exit 1
  rg -qF 'decideLayout' "${cli_claim}" || {
    echo "❌ ${cli_claim} does not apply the SHARED decision, so it could adopt a foreign directory" >&2
    exit 1
  }
  # Every path that creates state inside the home must go through the claim. These are the three
  # verified write sites; a fourth that skips the claim reintroduces the whole defect.
  rg -qF 'claimThenCreateLogDirectory' "${cli_pkg}/src/lib/daemon/supervisor.ts" || {
    echo "❌ the daemon supervisor creates <state home>/logs without claiming the home first" >&2
    exit 1
  }
  for writer in FileFleetScaffolder 'provisioner.apply'; do
    rg -qF "${writer}" "${cli_pkg}/bin/fy.ts" || {
      echo "❌ ${cli_pkg}/bin/fy.ts no longer wires ${writer}; re-check that its claim still guards it" >&2
      exit 1
    }
  done
  rg -qF 'claimStateHome' "${cli_pkg}/bin/fy.ts" || {
    echo "❌ ${cli_pkg}/bin/fy.ts does not claim the state home before the fleet writers run" >&2
    exit 1
  }
  # A refusal that does not name its repair is permanent: every home provisioned before the claim
  # existed lands there, and the only remaining move would be to delete the installation.
  rg -qF 'adopt' "${daemon_pkg}/src/lib/layout.ts" || {
    echo "❌ StateHomeLayoutError does not name the command that repairs an unclaimed home" >&2
    exit 1
  }
  rg -qF "'adopt'" "${cli_pkg}/src/lib/daemon/commands.ts" || {
    echo "❌ the repair command the daemon's refusal names does not exist on the CLI" >&2
    exit 1
  }
  ;;
state-home-default)
  # Three functions derive the default state home — the daemon's own, and the client's two. Two of
  # them used to spell `.ferretry` as a literal while the third derived it from the product name, so
  # they agreed only because the product happens to be called that. `scripts/local/rename.sh
  # --product` rewrites package scopes and manifests but NOT a literal inside a `.ts` file, so the
  # sanctioned rename path would have split one installation in two: `fy fleet` writing `~/.newname`
  # while `fy daemon` and the daemon itself used `~/.ferretry`, with nothing on either side saying
  # so. Pinning FY_HOME masks it entirely, which is how it survived this long.
  #
  # Only a quoted literal counts. These files have to EXPLAIN the hazard to be maintainable, and a
  # gate that fails on its own docblock teaches the next author to delete the explanation.
  for source in "${daemon_pkg}/src/lib/state-home.ts" "${cli_pkg}/src/lib/daemon/layout.ts" "${cli_pkg}/src/lib/fleet/layout.ts"; do
    set +e
    stray="$(rg --line-number -- "['\"]\.${product}['\"]" "${source}")"
    stray_status=$?
    set -e
    if [ "${stray_status}" -eq 0 ]; then
      echo "❌ ${source} writes the default state home out instead of deriving it from the product name:" >&2
      printf '%s\n' "${stray}" >&2
      exit 1
    fi
    [ "${stray_status}" -gt 1 ] && echo "❌ failed to scan ${source}" >&2 && exit "${stray_status}"
  done
  rg -qF 'productName' "${daemon_pkg}/src/lib/state-home.ts" || {
    echo "❌ ${daemon_pkg}/src/lib/state-home.ts does not derive its default from the product name" >&2
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
loopback-single-source)
  # One security fact has TWO legitimate input domains. An operator writes a host spelling, where
  # `localhost` is meaningful; a transport reports a peer address, where the IPv4-mapped IPv6 form
  # is meaningful and names never appear. Five anonymous predicates used to disagree across four
  # packages while each looked locally reasonable. Keep both named functions in the protocol and
  # make each consumer state which domain it has.
  address_source="packages/protocol/src/lib/address.ts"
  test -f "${address_source}"
  for predicate in isLoopbackHost isLoopbackPeer isWildcardHost; do
    rg -qF "export function ${predicate}" "${address_source}" || {
      echo "❌ ${address_source} does not own ${predicate}" >&2
      exit 1
    }
  done
  # The comments name the domains because merging the two sets would be as wrong as duplicating them.
  rg -qF 'A host SPELLING, as an operator writes one' "${address_source}"
  rg -qF "A socket's peer address, as a transport reports one" "${address_source}"

  api_server="packages/daemon/src/adapters/api/bun-api-server.ts"
  relay_connection="packages/relay/src/lib/connection.ts"
  pwa_directory="packages/pwa/src/features/onboarding/hosted-relay.ts"
  daemon_config="packages/daemon/src/lib/runtime/config.ts"
  cli_address="packages/cli/src/lib/daemon/address.ts"
  rg -qF 'isLoopbackPeer' "${api_server}" || {
    echo "❌ ${api_server} re-derived a peer address instead of using isLoopbackPeer" >&2
    exit 1
  }
  rg -qF 'isLoopbackHost' "${cli_address}" || {
    echo "❌ ${cli_address} re-derived a host spelling instead of using isLoopbackHost" >&2
    exit 1
  }
  rg -qF 'SocketEndpointSchema' "${pwa_directory}" || {
    echo "❌ ${pwa_directory} re-derived relay endpoint loopback instead of using the relay schema" >&2
    exit 1
  }
  rg -qF 'LOOPBACK' "${daemon_config}" || {
    echo "❌ ${daemon_config} does not read the default host from the protocol owner" >&2
    exit 1
  }

  # A SECOND DECLARED EXEMPTION, and the reason `${relay_connection}` is absent from both lists
  # below. The endpoint schema there is not asking what loopback is; it is asking which insecure
  # hosts a browser running the PUBLISHED site is permitted to dial at all, and that is settled by a
  # header file rather than by the machine. Its answer is deliberately NARROWER than the owner's:
  # `127.0.0.2`, `fy.localhost` and `[::1]` are all loopback and all blocked before a request
  # exists, so accepting them would have stored carriers that can only fail silently. Widening the
  # header instead would have handed the shipped app a plaintext reach it does not need.
  #
  # The exemption is pinned from both ends AT THE SAME TWO HOSTS: the predicate must still exist and
  # must still be declared over exactly this set, and the header must still allow exactly these four
  # origins and no fifth. Either side moving alone fails here, which is the only way a claim that
  # they agree can be worth anything.
  csp_headers="packages/pwa/public/_headers"
  rg -qF 'isLoopbackUnderPublishedCsp' "${relay_connection}" || {
    echo "❌ ${relay_connection} no longer defines the exempted published-CSP predicate; drop the exemption" >&2
    exit 1
  }
  rg -qF -- "new Set(['localhost', '127.0.0.1'])" "${relay_connection}" || {
    echo "❌ ${relay_connection} no longer reads exactly the two hosts ${csp_headers} allows insecurely" >&2
    exit 1
  }
  for allowed in 'http://localhost:*' 'http://127.0.0.1:*' 'ws://localhost:*' 'ws://127.0.0.1:*'; do
    rg -qF -- "${allowed}" "${csp_headers}" || {
      echo "❌ ${csp_headers} no longer allows ${allowed}, which ${relay_connection} accepts" >&2
      exit 1
    }
  done
  # And nothing beyond those four, because a fifth would be a host the schema silently refuses.
  insecure_allowances="$(rg --count-matches --fixed-strings -e 'http://' -e 'ws://' "${csp_headers}" | tr -d '[:space:]')"
  [ "${insecure_allowances}" != "4" ] && {
    echo "❌ ${csp_headers} allows ${insecure_allowances} insecure origins; ${relay_connection} accepts 2 hosts" >&2
    exit 1
  }

  # These are the predicate copies Wave 0 deletes. Quoted literals are forbidden here; tests
  # remain free to spell boundary values, and unrelated loopback services keep their own domains.
  for consumer in "${api_server}" "${pwa_directory}" "${daemon_config}" "${cli_address}"; do
    if rg -n --fixed-strings -- "'127.0.0.1'" "${consumer}"; then
      echo "❌ ${consumer} carries a loopback predicate literal instead of reading ${address_source}" >&2
      exit 1
    fi
  done

  # AND NO PRODUCTION FILE MAY DEFINE ONE AT ALL, which is the check that would have caught the copy
  # naming the four above did not. `packages/cli` kept a private `isLoopbackHost` through the whole of
  # Wave 0: it read `127.0.0.0/8` and every `.localhost` name while the owner read three spellings, so
  # `127.0.0.2` was this machine to the client spending an owner-only token on it and a stranger to
  # the pairing advertisement, which handed a phone a QR code for an address that names the phone.
  # A list of known copies cannot catch the copy that is not on the list; a definition can.
  #
  # TWO DECLARED EXEMPTIONS, each a different QUESTION rather than a second answer to this one, and
  # each checked above or below so an exemption cannot outlive the thing it exempts.
  #
  # The first is the reader in the app, which decides whether a hostname names the DEVICE HOLDING
  # THE BROWSER, on the far side of a tunnel from the daemon — which is why it counts the wildcard
  # as loopback, an answer that would be wrong everywhere in this domain.
  #
  # The second is `${relay_connection}`, pinned to the published `connect-src` above: what a
  # deployed browser may dial in plaintext, which is narrower than loopback and set by a header.
  browser_reader="packages/pwa/src/features/browser/in-app-browser-model.ts"
  rg -qF 'isLoopbackHostname' "${browser_reader}" || {
    echo "❌ ${browser_reader} no longer defines the exempted device predicate; drop the exemption" >&2
    exit 1
  }
  predicate_files=()
  while IFS= read -r -d '' path; do
    [ "${path}" = "${address_source}" ] && continue
    [ "${path}" = "${browser_reader}" ] && continue
    [ "${path}" = "${relay_connection}" ] && continue
    case "${path}" in
    */src/* | */bin/*) predicate_files+=("${path}") ;;
    esac
  done < <(git ls-files -z -co --exclude-standard -- packages)
  if [ "${#predicate_files[@]}" -gt 0 ]; then
    set +e
    copies="$(rg --line-number -- '(function|const|let|var)[[:space:]]+is(Loopback|Wildcard)[A-Za-z]*' "${predicate_files[@]}")"
    copy_status=$?
    set -e
    if [ "${copy_status}" -eq 0 ]; then
      echo "❌ a loopback or wildcard predicate is defined outside ${address_source}:" >&2
      printf '%s\n' "${copies}" >&2
      exit 1
    fi
    [ "${copy_status}" -gt 1 ] && echo "❌ failed to scan package source for loopback predicates" >&2 && exit "${copy_status}"
  fi
  ;;
pairing-fragment-readers)
  # THE PAIRING FRAGMENT HAS MORE THAN ONE READER, AND THAT IS WHAT BROKE.
  #
  # The daemon mints a link whose fragment carries a version. `packages/cli` reads it to render the
  # host's own pairing screen; `packages/pwa` reads it to decide a scan is a pairing claim at all.
  # When the daemon learned to mint `v2` — a fragment naming a rendezvous — the CLI still tested for
  # `#v1;` literally, so `fy pair` refused the daemon's own link: no code, no QR, no link, exit 1, on
  # a daemon that was working perfectly. The two-release rule that should have prevented it was
  # applied to the browser reader and missed the host one, because nobody had counted the readers.
  #
  # So this gate asserts the AGREEMENT rather than a version number, and it derives the version set
  # from the WRITER. A gate that listed the versions itself would be a third place to forget.
  fragment_owner="packages/protocol/src/lib/pairing.ts"
  cli_reader="${cli_pkg}/src/lib/pair/link.ts"
  pwa_reader="packages/pwa/src/lib/pairing.ts"
  for each in "${fragment_owner}" "${cli_reader}" "${pwa_reader}"; do
    [ ! -f "${each}" ] && echo "❌ pairing fragment reader is missing: ${each}" >&2 && exit 1
  done

  # One owner for "which versions exist". Both readers must ask it rather than spell one.
  rg -qF 'export const PAIRING_FRAGMENT_PATTERN' "${fragment_owner}" || {
    echo "❌ ${fragment_owner} no longer owns PAIRING_FRAGMENT_PATTERN" >&2
    exit 1
  }
  for reader in "${cli_reader}" "${pwa_reader}"; do
    rg -qF 'PAIRING_FRAGMENT_PATTERN' "${reader}" || {
      echo "❌ ${reader} does not recognise a pairing fragment through PAIRING_FRAGMENT_PATTERN" >&2
      exit 1
    }
    # The exact shape of the regression, refused by shape rather than by the string: prose may
    # discuss `#v1;`, but no reader may TEST for a version prefix of its own.
    set +e
    hardcoded="$(rg --line-number -- "startsWith\([\"'][#]v[0-9]" "${reader}")"
    hardcoded_status=$?
    set -e
    if [ "${hardcoded_status}" -eq 0 ]; then
      echo "❌ ${reader} tests a hard-coded fragment version instead of asking ${fragment_owner}:" >&2
      printf '%s\n' "${hardcoded}" >&2
      exit 1
    fi
    [ "${hardcoded_status}" -gt 1 ] && echo "❌ failed to scan ${reader} for a hard-coded version" >&2 && exit 1
  done

  # And the behaviour, because a shared constant proves nothing if the reader still refuses the link.
  # Every version the writer can EMIT is built for real and handed to the CLI's own check.
  # shellcheck disable=SC2016 # The JavaScript template literals must reach Bun without shell expansion.
  bun -e '
    const { formatPairingFragment, pairingLinkUrl, PAIRING_FRAGMENT_PATTERN } = await import(
      "./packages/protocol/src/lib/pairing.ts"
    );
    const { checkedPairUrl } = await import("./packages/cli/src/lib/pair/link.ts");
    const daemonUrl = "https://box.example";
    const base = { daemonUrl, code: "7F3K-Q2ND", daemonId: `fy_daemon_${"a".repeat(43)}` };
    // The two seeds a mint can produce: no rendezvous published, and one published.
    const seeds = [base, { ...base, relayCandidate: "wss://rendezvous.example" }];
    const versions = new Set();
    for (const seed of seeds) {
      const fragment = formatPairingFragment(seed);
      const version = fragment.slice(0, fragment.indexOf(";"));
      versions.add(version);
      if (!PAIRING_FRAGMENT_PATTERN.test(`#${fragment}`)) {
        throw new Error(`the shared recognizer refuses a fragment its own writer minted: ${version}`);
      }
      const pairUrl = pairingLinkUrl("https://ferretry.pages.dev/pair", seed);
      try {
        checkedPairUrl({ daemonUrl, pairUrl, reach: "any-device" });
      } catch (error) {
        throw new Error(`the CLI reader refuses a ${version} link the daemon can mint: ${error.message}`);
      }
    }
    if (versions.size < 2) {
      throw new Error("the writer emitted one version for both seeds; this gate is no longer proving anything");
    }
  ' || {
    echo "❌ a pairing link the daemon can mint is refused by the CLI that renders it" >&2
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
