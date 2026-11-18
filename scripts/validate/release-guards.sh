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
#                                             secret is gated on main (the preview's own workflow on rebuild/preview).
#   WHAT STOPS A TAG FROM PUBLISHING is cd.yaml's main-only job: the tagged commit must be on main, and EVERY other job
#   of cd.yaml (compile, the macOS smoke, GoReleaser publish, the Casks commit inside it, the signature) depends on it,
#   directly or through another job. This script proves that dependency below. Declared gap: a v* tag on a 5.0 commit
#   made before this guard would still publish (a tag runs the workflow file AT THE TAGGED COMMIT, so an older commit
#   runs the file it carries); no agent ever creates or pushes a tag (team rule).
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
#   4. The preview workflow (`pwa-pages-v5.yaml`) is triggered by pushes to `rebuild/preview` and
#      no other branch, every job's `if` OPENS with exactly that one-ref guard (only `&&` may follow it, never a
#      top-level `||`), its signing and deploy jobs use environments of their own, and its deploy job refuses a stale
#      commit (the run branch's head must equal GITHUB_SHA) in a step before `wrangler pages deploy`.
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
preview_ref_guard="github.ref == 'refs/heads/rebuild/preview'"

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
  # With the owner's MACOS_SMOKE=skip switch compile is SKIPPED, and a refused tag skips it too: only main-only's own
  # result tells the two apart, so goreleaser must need it and require its success.
  json "${cd_workflow}" | jq -e '.jobs.goreleaser.needs | index("main-only") != null' >/dev/null ||
    fail "${cd_workflow}: goreleaser must need main-only (a skipped compile does not prove the tag is on main)"
  json "${cd_workflow}" | jq -e '.jobs.goreleaser.if | contains("needs.main-only.result == '"'"'success'"'"'")' >/dev/null ||
    fail "${cd_workflow}: goreleaser's if must require main-only to have succeeded"
  # EVERY job other than main-only must depend on it, directly or through other jobs (a new publishing job cannot skip it).
  unguarded="$(json "${cd_workflow}" | jq -r '
    .jobs as $jobs
    | def needs($j): ($jobs[$j].needs // []) | if type == "array" then . else [.] end;
      def reach($j): needs($j) as $direct | $direct + ($direct | map(reach(.)) | add // []);
    $jobs | keys[] | select(. != "main-only") | select([reach(.)[] | select(. == "main-only")] | length == 0)')"
  [[ -z ${unguarded} ]] || fail "${cd_workflow}: job(s) not behind main-only, so a tag off main could run them: ${unguarded//$'\n'/, }"
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
  triggers "${preview}" | jq -e '.push.branches == ["rebuild/preview"] and ((.push | has("tags")) | not) and ((.push | has("paths")) | not)' >/dev/null ||
    fail "${preview} must be triggered by pushes to rebuild/preview alone"
  triggers "${preview}" | jq -e 'keys == ["push"]' >/dev/null ||
    fail "${preview} may be triggered only by a push (no workflow_dispatch: a dispatch would skip the never-backwards comparison)"
  # The guard must OPEN the `if`, and only `&&` may follow it: a correctly parenthesised guard followed by a top-level
  # `|| <anything>` would let another condition (another ref, an event) ride along outside it. `||` inside parentheses
  # or a quoted string is fine; one at parenthesis depth 0 after the guard is refused.
  json "${preview}" | jq -e --arg g "${preview_ref_guard}" '
    def top_level_or($s):
      ($s | gsub("'"'"'[^'"'"']*'"'"'"; "'"''"'")) as $t
      | (reduce ($t | explode[]) as $c ({d: 0, p: 0, bad: false};
          if $c == 40 then .d += 1 | .p = $c
          elif $c == 41 then .d -= 1 | .p = $c
          elif $c == 124 and .p == 124 and .d == 0 then .bad = true | .p = 0
          else .p = $c end)) | .bad;
    [.jobs[] | .if // ""] | all(startswith($g) and (.[($g | length):] | top_level_or(.) | not))' >/dev/null ||
    fail "every job of ${preview} must open its if with ${preview_ref_guard}, followed only by && conditions (no top-level ||)"
  # A STALE COMMIT MUST NOT DEPLOY LAST. The concurrency group serialises runs but does not order them, so the deploy
  # job must, in a step BEFORE the `wrangler pages deploy` one, read the run's own branch head (read-only
  # `git ls-remote --exit-code --heads`), compare it with GITHUB_SHA and exit non-zero when they differ.
  json "${preview}" | jq -e '
    .jobs.deploy.steps as $steps
    | ([$steps | to_entries[] | select((.value.run // "") | contains("wrangler pages deploy")) | .key] | first) as $deploy_at
    | $deploy_at != null
      and ([$steps | to_entries[]
            | select(.key < $deploy_at)
            | select((.value.run // "") as $r
                | ($r | contains("git ls-remote --exit-code --heads \"https://github.com/${REPOSITORY}\" \"refs/heads/${BRANCH}\""))
                  and ($r | contains("!= \"${GITHUB_SHA}\""))
                  and ($r | contains("exit 1")))]
           | length > 0)' >/dev/null ||
    fail "${preview}: the deploy job must, before wrangler pages deploy, read the run branch head with git ls-remote --exit-code --heads, refuse (exit 1) unless it equals GITHUB_SHA (an older commit must not publish after a newer one)"
  # THE DEPLOY JOB IS THE AUTHORITY ON "NEVER BACKWARDS". GitHub can re-run it alone on a stale gate result, so a step
  # BEFORE `wrangler pages deploy` must read the project's production deployment from the Pages API (canonical_deployment)
  # and ask git whether it is an ancestor (`merge-base --is-ancestor`), and the upload must be skippable only by that step.
  json "${preview}" | jq -e '
    .jobs.deploy.steps as $steps
    | ([$steps | to_entries[] | select((.value.run // "") | contains("wrangler pages deploy")) | .key] | first) as $deploy_at
    | $deploy_at != null
      and ([$steps | to_entries[]
            | select(.key < $deploy_at)
            | select((.value.run // "") as $r
                | ($r | contains("api.cloudflare.com/client/v4/accounts/"))
                  and ($r | contains("canonical_deployment"))
                  and ($r | contains("merge-base --is-ancestor"))
                  and ($r | contains("fail")))]
           | length > 0)' >/dev/null ||
    fail "${preview}: the deploy job must, before wrangler pages deploy, read the production deployment from the Cloudflare Pages API (canonical_deployment) and refuse (git merge-base --is-ancestor) a commit that is not a descendant of it (a re-run of the deploy job alone must not reuse a stale gate)"
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
echo "✅ every job of cd.yaml sits behind main-only, so a tag off main publishes nothing for commits made after this guard lands (a v* tag on a 5.0 commit made before this guard would still publish; no agent ever creates or pushes a tag); the preview deploys from rebuild/preview alone"
