#!/usr/bin/env bash
set -euo pipefail

# Move the repository to another GitHub owner in one shot.
#   The owner lives in ONE place: root package.json `repository` ("github:<owner>/<repo>").
#   The repo half equals the product name (two-name model), so a repo rename is
#   `scripts/local/rename.sh --product <name>`, which moves the repository field with it.
# This script rewrites the owner in that field and in every shipped file that carries it (the cask,
# GoReleaser, the installers, INSTALLATION.md, the get-started page, onboarding commands, the daemon's
# update addresses, user docs), then runs the gate that proves nothing was missed. Idempotent: a second
# run with the same owner changes nothing.
# The runbook names no real owner (`<old-owner>` / `<new-owner>` placeholders), so this script never
# rewrites the migration instructions; it prints them filled in with both owners at the end of the run.
#
# Usage: scripts/local/move-repo.sh --owner <github-owner>
# Runbook: docs/runbooks/move-repo.md

usage="usage: $0 --owner <github-owner>"
new_owner=""
while [ "$#" -gt 0 ]; do
  case "$1" in
  --owner)
    new_owner="${2:-}"
    shift 2
    ;;
  *)
    echo "❌ ${usage}" >&2
    exit 2
    ;;
  esac
done
[ -z "${new_owner}" ] && echo "❌ ${usage}" >&2 && exit 2
[[ ${new_owner} =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,38})$ ]] || {
  echo "❌ a GitHub owner is 1-39 letters, digits or hyphens and starts with a letter or digit, got '${new_owner}'" >&2
  exit 2
}

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

allowlist="scripts/validate/repo-slug-allowlist.txt"
old_slug="$(jq -r '.repository // empty | ltrimstr("github:")' package.json)"
[[ ${old_slug} =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ ]] && [ -f "${allowlist}" ] || {
  echo "❌ package.json \`repository\` must be \"github:<owner>/<repo>\" and ${allowlist} must exist" >&2
  exit 1
}
old_owner="${old_slug%%/*}"
repo="${old_slug#*/}"

echo "🔁 owner: '${old_owner}' -> '${new_owner}'  (repo '${repo}' unchanged)"

# Three populations (see the allowlist): addresses are rewritten everywhere not listed; `follow` files
# are rewritten in full; `history` and `fixture` files are left alone.
excludes=()
follows=()
while read -r mode spec; do
  case "${mode}" in
  history | fixture) excludes+=(":(exclude)${spec}") ;;
  follow)
    excludes+=(":(exclude)${spec}")
    follows+=("${spec}")
    ;;
  '' | '#'*) ;;
  *) echo "❌ ${allowlist}: unknown mode '${mode}'" >&2 && exit 1 ;;
  esac
done <"${allowlist}"

changed=()

# 1. The single source.
jq --arg slug "github:${new_owner}/${repo}" '.repository = $slug' package.json >package.json.tmp
if cmp -s package.json package.json.tmp; then rm package.json.tmp; else
  mv package.json.tmp package.json
  changed+=("package.json")
fi

# 2. Every `<owner>/<repo>` in a release, clone, tap, flake or API address. The link to one issue or
# pull request is history and is protected: GitHub redirects it after the transfer.
context='(github\.com[/:]|github:|github-personal:|repos/|tap |--repo |REPO=")'
keep='@@KEEP-OWNER@@'
while IFS= read -r -d '' file; do
  before="$(cksum <"${file}")"
  sed -E -i \
    -e "s#${context}${old_owner}/${repo}/(pull|issues)/#\\1${keep}/${repo}/\\2/#g" \
    -e "s#${context}${old_owner}/${repo}([^A-Za-z0-9_-]|\$)#\\1${new_owner}/${repo}\\2#g" \
    -e "s#${keep}#${old_owner}#g" \
    "${file}"
  [ "${before}" = "$(cksum <"${file}")" ] || changed+=("${file}")
done < <(git grep -lz -I -F "${old_owner}/${repo}" -- . "${excludes[@]}" || true)

# 2b. Tests that assert a shipped address follow it in full, so they keep asserting what ships.
while IFS= read -r -d '' file; do
  before="$(cksum <"${file}")"
  sed -E -i "s#\\b${old_owner}/${repo}\\b#${new_owner}/${repo}#g" "${file}"
  [ "${before}" = "$(cksum <"${file}")" ] || changed+=("${file}")
done < <(git grep -lz -I -F "${old_owner}/${repo}" -- "${follows[@]}" || true)

# 3. The owner fields that carry no `<owner>/<repo>` text.
fields=(
  ".goreleaser.yaml|s#^(\\s+owner:\\s*)${old_owner}\\s*\$#\\1${new_owner}#"
  "packages/protocol/src/lib/daemon-update.ts|s#^(export const RELEASE_OWNER = ')${old_owner}(';)\$#\\1${new_owner}\\2#"
)
for field in "${fields[@]}"; do
  file="${field%%|*}"
  before="$(cksum <"${file}")"
  sed -E -i -e "${field#*|}" "${file}"
  [ "${before}" = "$(cksum <"${file}")" ] || changed+=("${file}")
done

# Report, then prove it.
if [ "${#changed[@]}" -eq 0 ]; then
  echo "  (nothing to change: already '${new_owner}')"
else
  printf '%s\n' "${changed[@]}" | awk '!seen[$0]++ { printf "  rewrote %s\n", $0 }'
fi
bash scripts/validate/repo-slug.sh

echo ""
echo "📝 remaining manual steps (docs/runbooks/move-repo.md). Both owners are filled in below; the runbook"
echo "   itself keeps <old-owner>/<new-owner> placeholders and this script never rewrites it:"
echo "  1. review 'git diff', commit with a title that triggers a release (NOT 'chore:'), push, re-run CI:"
echo "       fix(release): move the repository to ${new_owner}"
echo "  2. after the merge, verify the new tag and its assets exist on the new owner:"
echo "       git ls-remote --tags git@github.com:${new_owner}/${repo}.git 'v*' | tail -3"
echo "       gh release view --repo ${new_owner}/${repo}"
echo "  3. every clone:"
echo "       git remote set-url origin git@github.com:${new_owner}/${repo}.git"
echo "  4. every daemon:  fy daemon update --yes"
echo "  5. every Mac or Linux machine installed through Homebrew (the daemon keeps its state home):"
echo "       brew uninstall --cask ${repo}"
echo "       brew untap ${old_owner}/${repo}"
echo "       brew tap ${new_owner}/${repo} https://github.com/${new_owner}/${repo}"
echo "       brew install --cask ${new_owner}/${repo}/${repo}"
echo "       fy daemon restart"
echo "  6. Nix users:  github:${old_owner}/${repo}  ->  github:${new_owner}/${repo}  in their flake inputs, then 'nix flake update ${repo}'"
echo "✅ move complete"
