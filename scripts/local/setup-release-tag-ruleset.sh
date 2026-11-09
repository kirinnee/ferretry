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
# WHAT THIS RULESET IS, HONESTLY. The ruleset refuses Write-role collaborators only. On this repository every agent
# pushes as the owner (Admin), and Admin is the bypass actor the release token needs, so the ruleset does NOT stop an
# agent's `v*` tag: an agent with the owner's credential can still push one. What stops a 5.0 tag from publishing is
# `cd.yaml`'s main-only job: the tagged commit must be on main, and every publishing job and the Casks commit depend on
# it (scripts/validate/release-guards.sh holds that). Caveat: a tag runs the workflow file AT THE TAGGED COMMIT, so the
# job only covers commits that already carry it. Declared gap: "an agent with the owner's credential can still push a v*
# tag; it cannot publish from a 5.0 commit".
#
# WHAT IT DOES. Creating, moving or deleting a tag matching `refs/tags/v*` is refused to everyone EXCEPT the bypass
# actors: by default the repository role Admin, which is the actor behind `RELEASE_TOKEN` when that token is a
# personal access token of the repository's owner (semantic-release in release.yaml pushes the tag as that token's
# actor, which is why a PAT is required there: tags pushed with the default GITHUB_TOKEN do not trigger CD). Write-role
# collaborators are not bypass actors, so they cannot push a release tag. After it writes the ruleset the script READS IT
# BACK and prints the bypass actors by name, so you can see what role id 5 means.
# CHECK BEFORE YOU RUN IT: if RELEASE_TOKEN belongs to someone who is not an admin, or is a GitHub App's token, run it
# with `--role maintain` or `--app-id <the app's id>` as that fits, or the next real release cannot tag. GitHub rulesets
# cannot name a single user as a bypass actor, only a role, a team or an app. (`maintain` has no meaning on a personal
# repository.)

dry_run=0
repo="${GH_REPO:-}"
role="admin"
app_id=""
while [[ $# -gt 0 ]]; do
  case "$1" in
  --dry-run) dry_run=1 && shift ;;
  --repo)
    [[ $# -ge 2 ]] || { echo "❌ --repo needs a value (owner/name)" >&2 && exit 64; }
    repo="$2" && shift 2
    ;;
  --role)
    [[ $# -ge 2 ]] || { echo "❌ --role needs a value (admin or maintain)" >&2 && exit 64; }
    role="$2" && shift 2
    ;;
  --app-id)
    [[ $# -ge 2 ]] || { echo "❌ --app-id needs a value (a number)" >&2 && exit 64; }
    app_id="$2" && shift 2
    ;;
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
  echo "📝 bypass: the repository role '${role}'${app_id:+ and the GitHub App ${app_id}} can create, move or delete a v* tag; Write-role collaborators are refused"
  echo "📝 NOT a guard against an agent that pushes with the owner's (Admin) credential: what stops a 5.0 tag from publishing is cd.yaml's main-only job"
  echo "   [dry-run] after the write: gh api repos/${repo}/rulesets/<id>  (read it back and print the bypass actors by name)"
  echo "   [dry-run] gh api repos/${repo}/rulesets  (find a ruleset named ${name})"
  echo "   [dry-run] gh api --method POST|PUT repos/${repo}/rulesets[/<id>] --input - <<< '${ruleset}'"
  exit 0
fi

command -v gh >/dev/null || { echo "❌ gh is not installed" >&2 && exit 1; }
command -v jq >/dev/null || { echo "❌ jq is not installed" >&2 && exit 1; }
repo="${repo:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
echo "📝 repository: ${repo}"
existing="$(gh api --paginate "repos/${repo}/rulesets" --jq ".[] | select(.name == \"${name}\") | .id")"
if [[ -n ${existing} ]]; then
  echo "🔁 updating the existing ruleset ${name} (${existing})"
  ruleset_id="${existing}"
  gh api --method PUT "repos/${repo}/rulesets/${ruleset_id}" --input - <<<"${ruleset}" >/dev/null
else
  ruleset_id="$(gh api --method POST "repos/${repo}/rulesets" --input - --jq .id <<<"${ruleset}")"
fi
# Read it back: what GitHub holds, not what was sent.
back="$(gh api "repos/${repo}/rulesets/${ruleset_id}")"
echo "📝 bypass actors on the ruleset ${name} (${ruleset_id}), as GitHub holds them:"
jq -r '.bypass_actors[] | "   - \(.actor_type) \(.actor_id) (\(if .actor_type == "RepositoryRole" then ({"5":"Admin","2":"Maintain","4":"Write","1":"Read","3":"Triage"}[(.actor_id | tostring)] // "unknown role") else "see the repository settings" end)), bypass_mode \(.bypass_mode)"' <<<"${back}"
echo "✅ ruleset ${name} applied: Write-role collaborators can no longer push a v* tag."
echo "⚠️  an agent using the owner's (Admin) credential still can; it cannot publish from a 5.0 commit, because cd.yaml's main-only job needs the tagged commit on main."
