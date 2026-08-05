#!/usr/bin/env bash
set -euo pipefail

# `fyd` gained `@ferretry/relay`, but Nix's hand-maintained workspace link list did not. The
# documented `nix shell github:kirinnee/ferretry` install then stopped building while every CI gate
# stayed green, because CI installed the real Bun workspace and never exercised Nix's private
# node_modules tree. Generate the links from the root workspace declaration and verify the result in
# Pre-Commit, so a new direct or transitive workspace import has no second list to update.

fail() {
  echo "❌ $*" >&2
  exit 1
}

usage() {
  echo "usage: $0 <link|check> <node_modules> | $0 self-test" >&2
  exit 2
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd -- "${script_dir}/../.." && pwd)"
cd "${root_dir}"

workspace_manifests=()
scope=""

load_workspace() {
  local manifest manifest_pattern matches package_name pattern patterns_text product status
  local -a patterns=()
  local -A seen=()

  product="$(jq -er '.name | select(type == "string" and length > 0)' package.json)" ||
    fail "root package.json must declare a non-empty string name"
  [[ ${product} =~ ^[a-z0-9._-]+$ ]] || fail "root package name is not a safe npm scope: ${product}"
  scope="@${product}/"

  patterns_text="$(jq -er '
    .workspaces |
    if type == "array" and length > 0 and all(.[]; type == "string" and length > 0)
    then .[]
    else error("workspaces must be a non-empty string array")
    end
  ' package.json)" || fail "root package.json must declare a non-empty workspace string array"
  mapfile -t patterns <<<"${patterns_text}"

  shopt -s globstar
  for pattern in "${patterns[@]}"; do
    [[ ${pattern} != /* ]] || fail "workspace patterns must be relative: ${pattern}"
    [[ ! ${pattern} =~ (^|/)\.\.(/|$) ]] || fail "workspace patterns must stay inside the repository: ${pattern}"
    [[ ! ${pattern} =~ [[:space:]] ]] || fail "workspace patterns containing whitespace are unsupported: ${pattern}"

    manifest_pattern="${pattern%/}/package.json"
    set +e
    matches="$(compgen -G "${manifest_pattern}")"
    status=$?
    set -e
    [[ ${status} -le 1 ]] || fail "could not expand workspace pattern: ${pattern}"
    [[ ${status} -eq 0 && -n ${matches} ]] || fail "workspace pattern matched no package manifests: ${pattern}"

    while IFS= read -r manifest; do
      [[ -f ${manifest} ]] || fail "workspace manifest is not a file: ${manifest}"
      seen["${manifest}"]=1
    done <<<"${matches}"
  done

  [[ ${#seen[@]} -gt 0 ]] || fail "root workspace declaration resolved to no package manifests"
  mapfile -t workspace_manifests < <(printf '%s\n' "${!seen[@]}" | sort)

  for manifest in "${workspace_manifests[@]}"; do
    package_name="$(jq -er '.name | select(type == "string" and length > 0)' "${manifest}")" ||
      fail "workspace manifest must declare a non-empty string name: ${manifest}"
    case "${package_name}" in
    "${scope}"*)
      package_name="${package_name#"${scope}"}"
      [[ -n ${package_name} && ${package_name} != */* && ${package_name} != . && ${package_name} != .. ]] ||
        fail "workspace package name cannot form a safe scoped link: ${manifest}"
      ;;
    esac
  done
}

link_workspaces() {
  local link manifest node_modules package_name workspace_dir
  node_modules="$1"
  load_workspace
  mkdir -p "${node_modules}/${scope%/}"

  for manifest in "${workspace_manifests[@]}"; do
    package_name="$(jq -r '.name' "${manifest}")"
    [[ ${package_name} == "${scope}"* ]] || continue
    workspace_dir="$(dirname "${manifest}")"
    link="${node_modules}/${package_name}"
    [[ ! -e ${link} && ! -L ${link} ]] || fail "refusing to replace existing workspace link: ${link}"
    ln -s "${root_dir}/${workspace_dir}" "${link}"
  done
}

check_workspaces() {
  local actual expected link manifest node_modules package_name scoped_count workspace_dir
  node_modules="$1"
  [[ -d ${node_modules} ]] || fail "node_modules directory is missing: ${node_modules}"
  load_workspace
  scoped_count=0

  # Validate every scoped workspace, not only the two compiled packages' direct dependencies. This
  # strict superset remains closed over every transitive edge (for example fyd -> relay -> protocol)
  # without having to reproduce Bun's module graph in another parser.
  for manifest in "${workspace_manifests[@]}"; do
    package_name="$(jq -r '.name' "${manifest}")"
    [[ ${package_name} == "${scope}"* ]] || continue
    scoped_count=$((scoped_count + 1))
    workspace_dir="$(dirname "${manifest}")"
    link="${node_modules}/${package_name}"
    expected="$(realpath "${root_dir}/${workspace_dir}")"

    [[ -L ${link} ]] || fail "missing Nix workspace link: ${link} -> ${expected}"
    actual="$(realpath "${link}")" || fail "broken Nix workspace link: ${link}"
    [[ ${actual} == "${expected}" ]] ||
      fail "wrong Nix workspace link: ${link} -> ${actual}; expected ${expected}"
  done

  [[ ${scoped_count} -gt 0 ]] || fail "workspace contains no scoped packages to link"
}

assert_nix_mount() {
  local nix_file="nix/ferretry.nix"
  rg -qF './scripts/validate/nix-workspace-links.sh link node_modules' "${nix_file}" ||
    fail "${nix_file} does not invoke the derived workspace linker"
  rg -qF './scripts/validate/nix-workspace-links.sh check node_modules' "${nix_file}" ||
    fail "${nix_file} does not verify the generated workspace links"
}

mode="${1:-}"
case "${mode}" in
link)
  [[ $# -eq 2 ]] || usage
  link_workspaces "$2"
  ;;
check)
  [[ $# -eq 2 ]] || usage
  check_workspaces "$2"
  echo "✅ Nix workspace links cover every scoped workspace package"
  ;;
self-test)
  [[ $# -eq 1 ]] || usage
  assert_nix_mount
  scratch_dir="$(mktemp -d)"
  trap 'rm -rf -- "${scratch_dir:?}"' EXIT
  link_workspaces "${scratch_dir}/node_modules"
  check_workspaces "${scratch_dir}/node_modules"
  echo "✅ Nix workspace link generation contract passed"
  ;;
*)
  usage
  ;;
esac
