#!/usr/bin/env bash
set -euo pipefail

# Move the repository's OWNER (GitHub org/user) and/or REPO slug in one repeatable command.
#   The single source is the root package.json `repository` field ("github:<owner>/<repo>"), the way
#   the product name is the root `name` (docs/standards/architecture). This script writes the new value
#   there, then rewrites every other literal that must agree with it: the cask and installer URLs,
#   GoReleaser's release and tap owner, `RELEASE_OWNER`, install commands in docs and the onboarding
#   page, and the fixtures that mirror them. `cli-contracts.sh repo-owner-single-source` refuses a
#   hand-written owner afterwards.
#   The root manifest is also an input of the Nix dependency build, so --apply refreshes the install digest pinned in
#   nix/bun-deps.inputs (Nix computes it offline); where Nix cannot, it ends INCOMPLETE (non-zero) naming the command.
#
# DRY RUN BY DEFAULT: it lists what it would change and writes nothing. Pass --apply to write.
# It touches only this working tree: it never pushes, never calls `gh`, never edits another repository.
# Run it BEFORE scripts/local/rename.sh when a product rename moves the repo name too.
#
# Usage: scripts/local/move-repo.sh [--owner <owner>] [--repo <repo>] [--apply]

new_owner=""
new_repo=""
apply=0
usage="usage: $0 [--owner <owner>] [--repo <repo>] [--apply]"
while [ "$#" -gt 0 ]; do
  case "$1" in
  --owner)
    new_owner="${2:-}"
    shift 2
    ;;
  --repo)
    new_repo="${2:-}"
    shift 2
    ;;
  --apply)
    apply=1
    shift
    ;;
  *)
    echo "❌ ${usage}" >&2
    exit 2
    ;;
  esac
done
[ -z "${new_owner}" ] && [ -z "${new_repo}" ] && echo "❌ ${usage}" >&2 && exit 2
[ -n "${new_owner}" ] && ! [[ ${new_owner} =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] &&
  echo "❌ --owner must be a GitHub login (letters, digits, hyphens), got '${new_owner}'" >&2 && exit 2
[ -n "${new_repo}" ] && ! [[ ${new_repo} =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] &&
  echo "❌ --repo must be a GitHub repository name (letters, digits, . _ -), got '${new_repo}'" >&2 && exit 2

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

old_slug="$(jq -r '.repository // empty' package.json | sed -n 's/^github://p')"
[[ ${old_slug} =~ ^([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)$ ]] ||
  { echo "❌ root package.json \`repository\` must be \"github:<owner>/<repo>\", got '${old_slug}'" >&2 && exit 1; }
old_owner="${BASH_REMATCH[1]}"
old_repo="${BASH_REMATCH[2]}"
new_owner="${new_owner:-${old_owner}}"
new_repo="${new_repo:-${old_repo}}"
new_slug="${new_owner}/${new_repo}"
[ "${new_slug}" = "${old_slug}" ] && echo "✅ already ${old_slug}; nothing to move" && exit 0

mode="dry run (nothing written; pass --apply to write)"
[ "${apply}" = 1 ] && mode="APPLY"
echo "🔁 repository: '${old_slug}' -> '${new_slug}' [${mode}]"

# Tracked text files that name the old OWNER. The changelogs record history and the lockfile is not
# ours to hand-edit, so they stay as they are.
mapfile -d '' files < <(git grep -IlzF -e "${old_owner}" -- . ':!Changelog*.md' ':!IncrementalChangelog.md' ':!bun.lock' || true)

# One pass per file: the shapes below are the ONLY ways this repository spells its own slug or owner.
# Each is bounded so `kirinnee97` (the Gemfury account), `kirinnee/pitwall` (another repository) and
# an account label such as "GitHub · kirinnee" are left alone.
# shellcheck disable=SC2016 # the Perl program is single-quoted on purpose: $ belongs to Perl, not the shell
rewrite='
  use strict; use warnings;
  my ($oo, $or, $no, $nr, $apply) = @ENV{qw(OLD_OWNER OLD_REPO NEW_OWNER NEW_REPO APPLY)};
  my ($changed, $total) = (0, 0);
  for my $file (@ARGV) {
    open my $in, "<", $file or die "$file: $!";
    local $/; my $text = <$in>; close $in;
    my $n = 0;
    # the full slug, as a URL, flake ref, tap, API path, ssh remote, or a shell default (`${VAR:-<slug>}`)
    # (a `.git` remote or a sentence-ending dot still matches; `<repo>.tools`, `<repo>.git.tools` and `<repo>.git-tools`
    # are other repositories and do not: only an optional `.git` may follow, and then no name character or `.<name>`)
    $n += ($text =~ s{(?:(?<![A-Za-z0-9_.-])|(?<=:-))\Q$oo\E/\Q$or\E(?=(?:\.git)?(?![A-Za-z0-9_-]|\.[A-Za-z0-9]))}{$no/$nr}g);
    # the release owner and repository constants
    $n += ($text =~ s{(RELEASE_OWNER = \x27)\Q$oo\E(\x27)}{$1$no$2}g);
    $n += ($text =~ s{(RELEASE_REPO = \x27)\Q$or\E(\x27)}{$1$nr$2}g);
    # GoReleaser: the release repository and the tap repository (an owner line followed by its name)
    $n += ($text =~ s{^(\s+owner: )\Q$oo\E(\n\s+name: )\Q$or\E$}{$1$no$2$nr}mg);
    next if $n == 0;
    print "  $n\t$file\n";
    $changed++; $total += $n;
    next unless $apply;
    open my $out, ">", $file or die "$file: $!";
    print $out $text; close $out;
  }
  print "  $total change(s) in $changed file(s)\n";
'
(
  export OLD_OWNER="${old_owner}" OLD_REPO="${old_repo}" NEW_OWNER="${new_owner}" NEW_REPO="${new_repo}" APPLY="${apply}"
  perl -e "${rewrite}" -- "${files[@]}"
)

printf "  1\tpackage.json (repository)\n"
[ "${apply}" = 0 ] && [ -f nix/bun-deps.inputs ] && printf "  1\tnix/bun-deps.inputs (install digest, recomputed by Nix)\n"
if [ "${apply}" = 1 ]; then
  jq --arg slug "github:${new_slug}" '.repository = $slug' package.json >package.json.tmp
  mv package.json.tmp package.json

  echo ""
  "${root_dir}/scripts/validate/cli-contracts.sh" repo-owner-single-source ||
    { echo "❌ leftovers above: fix them by hand, then re-run the check" >&2 && exit 1; }

  # The root manifest is an install input, so the move changes the Nix install digest pinned in nix/bun-deps.inputs
  # (scripts/validate/bun-deps-hash.sh fails until it is refreshed). Nix computes it offline from the working tree; the
  # dependency hash (`outputHash`) is untouched, because no installed dependency changed. Without Nix the move is
  # INCOMPLETE and says exactly what to run.
  pin="nix/bun-deps.inputs"
  digest_attribute=".#packages.x86_64-linux.bunDeps.installDigest"
  if [ -f "${pin}" ]; then
    if digest="$(nix --extra-experimental-features 'nix-command flakes' eval --offline --raw "${digest_attribute}" 2>/dev/null)" &&
      [[ ${digest} =~ ^[0-9a-f]{64}$ ]]; then
      printf '%s\n' "${digest}" >"${pin}"
      printf "  1\t%s (install digest)\n" "${pin}"
    else
      echo "" >&2
      echo "❌ incomplete: the files moved, but the Nix install digest pin (${pin}) could not be refreshed here" >&2
      echo "   next: digest=\"\$(nix eval --raw ${digest_attribute})\" && echo \"\${digest}\" > ${pin}" >&2
      echo "   then: scripts/validate/bun-deps-hash.sh   (it must print ✅)" >&2
      exit 1
    fi
  fi
  echo ""
  echo "📝 remaining manual steps (this script never touches GitHub or another repository):"
  echo "  - transfer / rename the GitHub repository itself, and update git remotes and the Pages / Cloudflare / secrets settings"
  echo "  - re-run: task setup && task lint && task test"
  echo "✅ move complete"
else
  echo ""
  echo "🔎 dry run: no file was written. Re-run with --apply to write."
fi
