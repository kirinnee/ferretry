#!/usr/bin/env bash
set -euo pipefail

# What the workflow files of THIS tree promise about releases, and what they cannot. Read the table, not the title.
#
# WHY. `rebuild/5.0` is a long-lived branch whose workflows run on every push to it, and a TAG is not a branch:
# `v*.*.*` fires for a tag on any commit. The release path is a chain of triggers (CI -> Release -> tag -> CD), and
# one unguarded link is enough, so this reads every workflow's triggers and holds each link to the ref.
#
# THE PROOF, HONESTLY (what governs, and where it stops)
#   workflow      trigger                    what keeps it off 5.0
#   release.yaml  workflow_run of CI on main  main's copy of the file governs (a workflow_run workflow runs the DEFAULT
#                                             branch's file), so this tree's copy decides nothing; the check below
#                                             keeps the copy honest for readers. A tag it pushes is on main.
#   cd.yaml       push of a v*.*.* tag        its `main-only` job refuses a tag not on main, but a tag run uses the file
#                                             AT THE TAGGED COMMIT: it covers commits made AFTER this merge only. A tag on
#                                             an older 5.0 commit (or a branch cut from one) runs the old, unguarded file.
#   everything else                          no tag trigger; every job that can write, use an environment or read a
#                                             secret is gated on main (the preview's own workflow on rebuild/5.0).
#   THE REST needs the owner's repository tag ruleset (scripts/local/setup-release-tag-ruleset.sh): only the release
#   actor may create a v* tag, so no workflow ever has to be trusted to refuse one. Until it is applied, any agent with
#   push access can tag an old commit and publish.
#
# WHAT IS CHECKED (per workflow, with yq and jq; `--root <dir>` checks another checkout).
#   1. Release (semantic-release): its only trigger is a `workflow_run` of CI on `main`, and its job repeats the
#      branch in its `if` (documentation of main's behaviour, not a guard on its own). `.releaserc.yaml` releases `main`
#      alone.
#   2. CD (GoReleaser, the cask, the daemon signature): the only workflow triggered by a tag. Its `main-only` job
#      proves the tag is on main and `compile` needs it. GoReleaser publishes only after a green compile
#      (scripts/validate/macos-policy.sh holds that `if`), so a tag off main reaches no publish, cask or signature
#      WHEN CD ITSELF CARRIES THE GUARD, which is true only of commits after this change.
#   3. Any other workflow with a job that can write (`contents: write`), use an environment or read a secret has every
#      such job gated on `github.ref == 'refs/heads/main'`, and no `push.tags` trigger.
#   4. The preview workflow (`pwa-pages-v5.yaml`) is triggered by pushes to `rebuild/5.0` alone, every job is gated on
#      that ref, and its signing and deploy jobs use environments of their own.
#   5. Nothing but CD and the Release workflow's own steps names `Casks/` or semantic-release.

root_dir="$(git rev-parse --show-toplevel)"
if [[ ${1:-} == --root ]]; then root_dir="$(cd "${2:?--root needs a directory}" && pwd)"; fi
cd "${root_dir}"

status=0
fail() {
  echo "❌ $*" >&2
  status=1
}

workflows=(.github/workflows/*.yaml)
json() { yq -o=json '.' "$1"; }

# `on` as JSON; YAML 1.1 reads a bare `on` key as the boolean true, which yq keeps as "on".
triggers() { json "$1" | jq -c '.on // .["true"] // {}'; }

release=.github/workflows/release.yaml
cd_workflow=.github/workflows/cd.yaml
preview=.github/workflows/pwa-pages-v5.yaml
main_ref="github.ref == 'refs/heads/main'"

# 1. Release
if [[ -f ${release} ]]; then
  [[ "$(triggers "${release}" | jq -c 'keys')" == '["workflow_run"]' ]] ||
    fail "${release} must be triggered by workflow_run alone"
  triggers "${release}" | jq -e '.workflow_run.workflows == ["CI"] and .workflow_run.branches == ["main"]' >/dev/null ||
    fail "${release} must run only after CI on main (workflow_run.workflows [CI], branches [main])"
  json "${release}" | jq -e '[.jobs[] | .if // ""] | all(contains("workflow_run.head_branch == '"'"'main'"'"'"))' >/dev/null ||
    fail "every job of ${release} must repeat head_branch == 'main' in its if"
fi
if [[ -f .releaserc.yaml ]]; then
  [[ "$(yq -o=json '.branches' .releaserc.yaml | jq -c '.')" == '["main"]' ]] ||
    fail ".releaserc.yaml must release main alone"
fi

# 2. CD
if [[ -f ${cd_workflow} ]]; then
  json "${cd_workflow}" | jq -e '.jobs["main-only"] != null' >/dev/null || fail "${cd_workflow} needs a main-only job"
  json "${cd_workflow}" | jq -e '.jobs["main-only"].steps | map(.run // "") | join("\n") | contains("merge-base --is-ancestor") and contains("origin/main")' >/dev/null ||
    fail "${cd_workflow}: main-only must prove the tagged commit is an ancestor of origin/main"
  json "${cd_workflow}" | jq -e '.jobs.compile.needs | (if type == "array" then . else [.] end) | index("main-only") != null' >/dev/null ||
    fail "${cd_workflow}: job compile must need main-only"
  json "${cd_workflow}" | jq -e '.jobs.goreleaser.if | contains("needs.compile.result == '"'"'success'"'"'")' >/dev/null ||
    fail "${cd_workflow}: goreleaser's if must require a successful compile, which main-only gates"
  json "${cd_workflow}" | jq -e '.jobs.goreleaser.needs | index("compile") != null' >/dev/null ||
    fail "${cd_workflow}: goreleaser must need compile"
fi

# 3. Everything else that can write, use an environment or read a secret
for workflow in "${workflows[@]}"; do
  [[ ${workflow} == "${release}" || ${workflow} == "${cd_workflow}" || ${workflow} == "${preview}" ]] && continue
  if triggers "${workflow}" | jq -e '(.push // {}) | has("tags")' >/dev/null; then
    fail "${workflow} is triggered by a tag; only CD may be"
  fi
  while IFS=$'\t' read -r job guarded; do
    [[ ${guarded} == yes ]] || fail "${workflow}: job ${job} can write, use an environment or read a secret, so its if must require ${main_ref}"
  done < <(json "${workflow}" | jq -r --arg ref "${main_ref}" '
    .jobs // {} | to_entries[]
    | select((.value | tostring | test("contents\": *\"write|secrets\\.|\"environment\"")))
    | "\(.key)\t\(if ((.value.if // "") | tostring | contains($ref)) then "yes" else "no" end)"')
done

# 4. The preview workflow
if [[ -f ${preview} ]]; then
  triggers "${preview}" | jq -e '.push.branches == ["rebuild/5.0"] and ((.push | has("tags")) | not) and ((.push | has("paths")) | not)' >/dev/null ||
    fail "${preview} must be triggered by pushes to rebuild/5.0 alone"
  triggers "${preview}" | jq -e '(keys | sort) == ["push", "workflow_dispatch"]' >/dev/null ||
    fail "${preview} may be triggered only by a push and a dispatch"
  json "${preview}" | jq -e '[.jobs[] | .if // ""] | all(contains("github.ref == '"'"'refs/heads/rebuild/5.0'"'"'"))' >/dev/null ||
    fail "every job of ${preview} must require github.ref == 'refs/heads/rebuild/5.0'"
  json "${preview}" | jq -e '(.jobs.sign.environment == "pwa-release-v5") and (.jobs.deploy.environment == "pwa-deploy-v5")' >/dev/null ||
    fail "${preview}: sign must use pwa-release-v5 and deploy pwa-deploy-v5"
  json "${preview}" | jq -e '[.jobs[] | .permissions // {} | .["contents"] // "none"] | all(. == "read")' >/dev/null ||
    fail "${preview} may only read contents"
  # The deploy holds a Pages-only token of its own, in its own environment: never the repository-level production token.
  if rg -q 'secrets\.CLOUDFLARE_API_TOKEN|secrets\.CLOUDFLARE_ACCOUNT_ID' "${preview}"; then
    fail "${preview} must not read the repository-level CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID; use the CLOUDFLARE_PAGES_V5_* secrets of pwa-deploy-v5"
  fi
  rg -q 'secrets\.CLOUDFLARE_PAGES_V5_API_TOKEN' "${preview}" ||
    fail "${preview} must deploy with secrets.CLOUDFLARE_PAGES_V5_API_TOKEN"
fi

# 5. Casks/ and semantic-release are named only where they belong
for workflow in "${workflows[@]}"; do
  [[ ${workflow} == "${release}" || ${workflow} == "${cd_workflow}" || ${workflow} == .github/workflows/ci.yaml ]] && continue
  if rg -q 'Casks/|semantic-release|goreleaser|gh release' "${workflow}"; then
    fail "${workflow} names Casks/, semantic-release, goreleaser or gh release; only CD and Release do"
  fi
done

((status == 0)) || exit 1
echo "✅ these workflows hold every release link to main for commits from here on; the repository tag ruleset (scripts/local/setup-release-tag-ruleset.sh) covers the rest; the preview deploys from rebuild/5.0 alone"
