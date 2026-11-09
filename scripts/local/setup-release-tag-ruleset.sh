#!/usr/bin/env bash
set -euo pipefail

# OWNER-RUN, ONCE: a repository tag ruleset that limits who can create, move or delete a `v*` tag. The owner runs it;
# an agent never does.
#
#   scripts/local/setup-release-tag-ruleset.sh [--dry-run] [--repo <owner/name>] [--role admin|maintain] [--app-id <id>]
#
#   --dry-run  print the ruleset and the calls and run nothing: no gh, no prompt.
#   --repo     the repository; default: the one `gh repo view` reports for this checkout.
#   --role     the repository role allowed to bypass the rule: `admin` (default) or `maintain`.
#   --app-id   also allow one GitHub App (its numeric id), for a RELEASE_TOKEN that is an App token.
#
# WHY THIS IS THE REAL GUARD. A tag is not a branch, and `cd.yaml` runs from the workflow file AT THE TAGGED COMMIT:
# every commit made before the `main-only` job reached it, and every branch cut from one, still carries an unguarded
# `cd.yaml`, so `git push origin v5.0.0-rc1` on such a commit would run GoReleaser, publish a GitHub release and commit
# `Casks/`. Any agent with push access can create that tag. Workflow edits cannot close this; only the repository can
# refuse the tag before any workflow runs. (`release.yaml` is no guard either: a `workflow_run` workflow always runs the
# DEFAULT branch's file, so main's copy governs.)
#
# WHAT IT ALLOWS. Creating, moving or deleting a tag matching `refs/tags/v*` is refused to everyone EXCEPT the bypass
# actors: by default the repository role Admin, which is the actor behind `RELEASE_TOKEN` when that token is a
# personal access token of the repository's owner (semantic-release in release.yaml pushes the tag as that token's
# actor, which is why a PAT is required there: tags pushed with the default GITHUB_TOKEN do not trigger CD). Agents and
# other contributors have the Write role, which is NOT a bypass actor, so they can no longer push a release tag.
# CHECK BEFORE YOU RUN IT: if RELEASE_TOKEN belongs to someone who is not an admin, or is a GitHub App's token, run it
# with `--role maintain` or `--app-id <the app's id>` as that fits, or the next real release cannot tag. GitHub rulesets
# cannot name a single user as a bypass actor, only a role, a team or an app.

dry_run=0
repo="${GH_REPO:-}"
role="admin"
app_id=""
while [[ $# -gt 0 ]]; do
  case "$1" in
  --dry-run) dry_run=1 && shift ;;
  --repo) repo="${2:-}" && shift 2 ;;
  --role) role="${2:-}" && shift 2 ;;
  --app-id) app_id="${2:-}" && shift 2 ;;
  *) echo "❌ usage: setup-release-tag-ruleset.sh [--dry-run] [--repo <owner/name>] [--role admin|maintain] [--app-id <id>]" >&2 && exit 64 ;;
  esac
done

# GitHub's fixed ids for the built-in repository roles.
case "${role}" in
admin) role_id=5 ;;
maintain) role_id=2 ;;
*) echo "❌ --role must be admin or maintain" >&2 && exit 64 ;;
esac
if [[ -n ${app_id} && ! ${app_id} =~ ^[0-9]+$ ]]; then
  echo "❌ --app-id must be a number" >&2
  exit 64
fi

name="release-tags"
actors="{\"actor_id\":${role_id},\"actor_type\":\"RepositoryRole\",\"bypass_mode\":\"always\"}"
if [[ -n ${app_id} ]]; then
  actors="${actors},{\"actor_id\":${app_id},\"actor_type\":\"Integration\",\"bypass_mode\":\"always\"}"
fi
ruleset="{\"name\":\"${name}\",\"target\":\"tag\",\"enforcement\":\"active\",\"conditions\":{\"ref_name\":{\"include\":[\"refs/tags/v*\"],\"exclude\":[]}},\"bypass_actors\":[${actors}],\"rules\":[{\"type\":\"creation\"},{\"type\":\"update\"},{\"type\":\"deletion\"}]}"

if [[ ${dry_run} -eq 1 ]]; then
  repo="${repo:-<owner/name from gh repo view>}"
  echo "📝 dry run: nothing below is executed"
  echo "📝 repository: ${repo}"
  echo "📝 allows: the repository role '${role}'${app_id:+ and the GitHub App ${app_id}} to create, move or delete a v* tag; everyone else is refused"
  echo "   [dry-run] gh api repos/${repo}/rulesets  (find a ruleset named ${name})"
  echo "   [dry-run] gh api --method POST|PUT repos/${repo}/rulesets[/<id>] --input - <<< '${ruleset}'"
  exit 0
fi

command -v gh >/dev/null || { echo "❌ gh is not installed" >&2 && exit 1; }
command -v jq >/dev/null || { echo "❌ jq is not installed" >&2 && exit 1; }
repo="${repo:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
echo "📝 repository: ${repo}"
existing="$(gh api "repos/${repo}/rulesets" --jq ".[] | select(.name == \"${name}\") | .id")"
if [[ -n ${existing} ]]; then
  echo "🔁 updating the existing ruleset ${name} (${existing})"
  gh api --method PUT "repos/${repo}/rulesets/${existing}" --input - <<<"${ruleset}" >/dev/null
else
  gh api --method POST "repos/${repo}/rulesets" --input - <<<"${ruleset}" >/dev/null
fi
echo "✅ only the repository role '${role}'${app_id:+ and the GitHub App ${app_id}} can now create, move or delete a v* tag"
