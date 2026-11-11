#!/usr/bin/env bash
set -euo pipefail

# Fails when a shipped file names a GitHub owner/repo that is not the one root package.json
# `repository` declares. That field is the single source; `scripts/local/move-repo.sh --owner <new>`
# rewrites everything derived from it, and this gate proves nothing was missed or reintroduced.
#
# Checked, in every tracked file the allowlist does not exempt:
#   - the repository half of the slug equals the product name (the two-name model keeps them equal);
#   - every `<owner>/<repo>` in a release, clone, tap, flake or API address names the source owner;
#   - `owner:` under the GoReleaser release and cask blocks, and RELEASE_OWNER in the protocol package.
# Gemfury (`kirinnee97`) and the Cloudflare workers.dev host are other accounts and never match.
#
# Usage: scripts/validate/repo-slug.sh

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

allowlist="scripts/validate/repo-slug-allowlist.txt"
fail() {
  echo "❌ repo-slug: $1" >&2
  exit 1
}
[ -f "${allowlist}" ] || fail "${allowlist} is missing"

# The single source and the product name.
source_slug="$(jq -r '.repository // empty | ltrimstr("github:")' package.json)"
product="$(jq -r '.name' package.json)"
[[ ${source_slug} =~ ^[A-Za-z0-9]([A-Za-z0-9-]*)/([A-Za-z0-9._-]+)$ ]] ||
  fail "package.json \`repository\` must be \"github:<owner>/<repo>\", got '${source_slug}'"
owner="${source_slug%%/*}"
repo="${source_slug#*/}"
[ "${repo}" = "${product}" ] ||
  fail "repository names '${repo}' but the product is '${product}'; they stay equal (rename.sh --product moves both)"

# Files in scope: tracked, minus every allowlisted pathspec (both modes — the gate checks neither).
excludes=()
while read -r mode spec; do
  case "${mode}" in
  history | fixture | follow) excludes+=(":(exclude)${spec}") ;;
  '' | '#'*) ;;
  *) fail "${allowlist}: unknown mode '${mode}'" ;;
  esac
done <"${allowlist}"
mapfile -d '' -t scope < <(git ls-files -z -- . "${excludes[@]}")
[ "${#scope[@]}" -gt 0 ] || fail "no files in scope"

status=0

# 1. Every slug in an address someone follows. `--` guards a path that begins with a dash.
slug_context='(github\.com[/:]|github:|github-personal:|repos/|tap |--repo |REPO=")'
hits="$(rg --no-messages --no-heading --line-number --only-matching \
  -e "${slug_context}[A-Za-z0-9_.-]+/${repo}(/(pull|issues)/|[^A-Za-z0-9_-]|\$)" -- "${scope[@]}" || true)"
while IFS= read -r hit; do
  [ -z "${hit}" ] && continue
  # A link to one issue or pull request is history; GitHub redirects it after a transfer.
  [[ ${hit} == */pull/ || ${hit} == */issues/ ]] && continue
  found="$(sed -E "s#^[^:]*:[0-9]+:${slug_context}([A-Za-z0-9_.-]+)/${repo}.*#\2#" <<<"${hit}")"
  [ "${found}" = "${owner}" ] && continue
  echo "❌ repo-slug: ${hit%%:*}:$(cut -d: -f2 <<<"${hit}") names '${found}/${repo}', the source is '${owner}/${repo}'" >&2
  status=1
done <<<"${hits}"

# 2. The owner fields that carry no `<owner>/<repo>` text to match.
check_owner() {
  local file="$1" pattern="$2" label="$3" values value
  values="$(rg --no-filename --only-matching --replace '$1' -e "${pattern}" -- "${file}" || true)"
  [ -n "${values}" ] || fail "${file}: found no ${label}"
  while IFS= read -r value; do
    [ "${value}" = "${owner}" ] && continue
    echo "❌ repo-slug: ${file} ${label} is '${value}', the source owner is '${owner}'" >&2
    status=1
  done <<<"${values}"
}
check_owner .goreleaser.yaml '^\s+owner:\s*(\S+)\s*$' 'GoReleaser owner'
check_owner packages/protocol/src/lib/daemon-update.ts "^export const RELEASE_OWNER = '([^']*)';" 'RELEASE_OWNER'

[ "${status}" -ne 0 ] && echo "   fix: scripts/local/move-repo.sh --owner ${owner}   (docs/runbooks/move-repo.md)" >&2 && exit 1
echo "✅ repo-slug: every shipped file names ${owner}/${repo}"
