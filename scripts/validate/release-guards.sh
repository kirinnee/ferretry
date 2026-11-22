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
#   5. The Cloudflare token never meets checkout code: a deploy job (the two PWA workflows AND the hosted relay and
#      link-store workflows) that reads a CLOUDFLARE secret (spelled any way: any case, `secrets[...]`, `toJSON(secrets)`,
#      `secrets: inherit`) has no checkout, no action but the SHA-pinned download/upload-artifact, no reusable workflow, no
#      nix, bun, bunx, npx, npm exec, npm x or clone, and runs wrangler only from an exact-version, secret-free npm install,
#      with the commit passed to `wrangler pages deploy` (a Worker `wrangler deploy` passes `--no-bundle`). In the two Worker
#      workflows a job that has checkout code (their `build`) reads no secret at all.
#   6. Nothing but CD and the Release workflow's own steps names `Casks/` or semantic-release.

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
  # THE PROJECT -> VERIFY -> DEPLOY CHAIN IS THE AUTHORITY ON "NEVER BACKWARDS". GitHub can re-run `deploy` alone on a
  # stale gate result, so BEFORE the upload (1) the `project` job, which holds the Cloudflare token and has no checkout
  # (no `./scripts/`), reads the project's production deployment from the Pages API (canonical_deployment) and hands
  # it on as an artifact, and (2) the `verify` job, which holds no secret at all (the pushed commit's scripts run
  # there), proves the signed record and asks git whether the live commit is an ancestor (`merge-base --is-ancestor`).
  # `deploy` needs both, and every hand-off artifact is named with the run attempt, so a deploy-only re-run finds
  # nothing of an earlier attempt's decision and fails closed.
  json "${preview}" | jq -e '
    ([.jobs.project.steps[]?
       | select((.run // "") as $r
           | ((.env // {}) | tostring | contains("secrets.CLOUDFLARE_PAGES_V5_API_TOKEN"))
             and ($r | contains("api.cloudflare.com/client/v4/accounts/"))
             and ($r | contains("canonical_deployment"))
             and (($r | contains("./scripts/")) | not))]
      | length > 0)
    and ([.jobs.verify.steps[]?
          | select((.run // "") as $r
              | (((.env // {}) | tostring | contains("secrets.")) | not)
                and (($r | contains("CLOUDFLARE")) | not)
                and ($r | contains("verify-pwa-release.sh"))
                and ($r | contains("merge-base --is-ancestor"))
                and ($r | contains("fail")))]
         | length > 0)
    and ((.jobs.verify | tostring | contains("secrets.")) | not)
    and ((.jobs.verify.needs // []) | index("project") != null)
    and ((.jobs.deploy.needs // []) | (index("project") != null and index("verify") != null))
    and ([.jobs.verify.steps[], .jobs.deploy.steps[], .jobs.project.steps[] | (.with.name // empty) | select(startswith("pages-project") or startswith("pwa-release-verified"))]
         | length > 0 and all(endswith("-${{ github.run_attempt }}")))' >/dev/null ||
    fail "${preview}: before the upload, the project job (token, no checkout) must read the production deployment from the Cloudflare Pages API, then the verify job (no secret, no Cloudflare variable) must verify the signed record and refuse (git merge-base --is-ancestor) a commit that is not a descendant of it; deploy must need both, and their hand-off artifacts must be named with github.run_attempt (a re-run of the deploy job alone must not reuse a stale decision, and the token must not reach the pushed commit's scripts)"
  json "${preview}" | jq -e '(.jobs.sign.environment == "pwa-release-v5") and (.jobs.deploy.environment == "pwa-deploy-v5") and (.jobs.project.environment == "pwa-deploy-v5") and ((.jobs.verify.environment // null) == null)' >/dev/null ||
    fail "${preview}: sign must use pwa-release-v5, project and deploy pwa-deploy-v5, and verify no environment"
  json "${preview}" | jq -e '[.jobs[] | .permissions // {} | .["contents"] // "none"] | all(. == "read")' >/dev/null ||
    fail "${preview} may only read contents"
  # The deploy holds a Pages-only token of its own, in its own environment: never the repository-level production token.
  if rg -q 'secrets\.CLOUDFLARE_API_TOKEN|secrets\.CLOUDFLARE_ACCOUNT_ID' "${preview}"; then
    fail "${preview} must not read the repository-level CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID; use the CLOUDFLARE_PAGES_V5_* secrets of pwa-deploy-v5"
  fi
  rg -q 'secrets\.CLOUDFLARE_PAGES_V5_API_TOKEN' "${preview}" ||
    fail "${preview} must deploy with secrets.CLOUDFLARE_PAGES_V5_API_TOKEN"
fi

# 5. THE CLOUDFLARE TOKEN NEVER MEETS CHECKOUT CODE. A job of a PWA deploy workflow that can read a CLOUDFLARE secret
# has no `actions/checkout`, no action but the SHA-pinned `actions/download-artifact` and `actions/upload-artifact` (an
# allow-list: no local, remote-composite or third-party action), no reusable workflow (a job that passes `secrets: inherit`
# is a holder too) and no run step that names `nix`, `bun`, `bunx`, `npx`, `npm exec`, `npm x`, `git clone` or
# `gh repo clone`: the checkout's flake shellHook, bun resolution and scripts would otherwise run with the token in their
# environment. Wrangler there is installed from npm at ONE exact version (`WRANGLER_VERSION`, the same in both
# workflows), by a step that holds no secret, before any step that runs it.
# GitHub contexts are case-insensitive, so every regex below is matched with the `i` flag.
#   holder: a CLOUDFLARE secret by name or by bracket, the whole `secrets` context (toJSON / fromJson(toJson(...))), or a
#           job that passes ALL of them on (`secrets: inherit`, the reusable-workflow form).
#   any_secret: any secret at all (the job-level and workflow-level env, and the install step, must hold none).
#   allowed_uses: the ONLY actions a token job may use, pinned by full SHA: no remote composite, no third party.
#   forbidden_run: a package runner or a clone a token job's run step must not name.
holder_re='secrets\.cloudflare|secrets\[|tojson\(\s*secrets|"secrets":"inherit"'
any_secret_re='secrets\.|secrets\[|tojson\(\s*secrets'
allowed_uses_re='^actions/(download|upload)-artifact@[0-9a-f]{40}$'
forbidden_run_re='(^|[^A-Za-z0-9_./-])(nix|bun|bunx|npx|npm\s+(-\S+\s+)*(exec|x)|git\s+clone|gh\s+repo\s+clone)([^A-Za-z0-9_-]|$)'
#   worker_workflows: the two hosted-Worker workflows (relay-hosted, link-store-hosted) hold the SAME token. Their `build` job
#           has the checkout and holds no secret at all; their token jobs follow every rule above, and a `wrangler deploy` in
#           one must publish the handed-over module as it is (`--no-bundle`), never bundle anything itself.
#   wrangler_use_re: a wrangler INVOCATION, at the start of a line or after `;`, `&`, `|` or `(` (so not the install's
#           `wrangler@x`, a path, or the word in a message).
pages_workflows=(.github/workflows/pwa-pages.yaml "${preview}")
worker_workflows=(.github/workflows/relay-hosted.yaml .github/workflows/link-store-hosted.yaml)
wrangler_use_re='(^|[\n;&|(])[[:space:]]*wrangler[[:space:]]'
checkout_re='actions/checkout|\./\.github/actions|nix develop|(^|[^A-Za-z0-9_./-])(nix|bun|bunx|npx)([^A-Za-z0-9_-]|$)'
wrangler_versions=()
for workflow in "${worker_workflows[@]}"; do
  if [[ ! -f ${workflow} ]]; then
    fail "${workflow} is missing: it holds the production Cloudflare token, and this guard proves it never meets checkout code"
    continue
  fi
  # A job that has the checkout (or a local action, nix, bun) holds NO secret at all: not the token, not the tunnel pool.
  while IFS= read -r job; do
    fail "${workflow}: job ${job} runs checkout code (actions/checkout, a local action, nix, bun) and also reads a secret; the build job must hold none"
  done < <(json "${workflow}" | jq -r --arg checkout "${checkout_re}" --arg anysecret "${any_secret_re}" '
    .jobs // {} | to_entries[]
    | select(.value | tostring | test($checkout))
    | select(.value | tostring | test($anysecret; "i"))
    | .key')
  # A token job publishes exactly the module `build` fingerprinted: no bundling of its own.
  json "${workflow}" | jq -e --arg holder "${holder_re}" --arg use "${wrangler_use_re}" '
    [.jobs // {} | to_entries[] | select(.value | tostring | test($holder; "i")) | .value.steps[]? | (.run // "")
     | select(test($use + "deploy"))] | all(test("wrangler[[:space:]]+deploy[^\n]*--no-bundle"))' >/dev/null ||
    fail "${workflow}: a wrangler deploy in a token job must pass --no-bundle on the same line (it publishes the handed-over module as it is; a token job bundles nothing)"
done
for workflow in "${pages_workflows[@]}" "${worker_workflows[@]}"; do
  [[ -f ${workflow} ]] || continue
  holders="$(json "${workflow}" | jq -r --arg holder "${holder_re}" '
    .jobs // {} | to_entries[]
    | select(.value | tostring | test($holder; "i"))
    | .key')"
  [[ -n ${holders} ]] || fail "${workflow}: no job reads a CLOUDFLARE secret, so the deploy token check has nothing to prove (renamed secret?)"
  while IFS=$'\t' read -r job why; do
    fail "${workflow}: job ${job} holds the Cloudflare token and ${why}; the token must never meet checkout code (a token job has no checkout, local or third-party action, reusable workflow, nix, bun, bunx, npx, npm exec or clone)"
  done < <(json "${workflow}" | jq -r --arg holder "${holder_re}" --arg anysecret "${any_secret_re}" --arg allowed "${allowed_uses_re}" --arg runner "${forbidden_run_re}" '
    .jobs // {} | to_entries[]
    | select(.value | tostring | test($holder; "i"))
    | .key as $job
    | (if (.value.uses // null) != null then ["\($job)\tcalls a reusable workflow"] else [] end)
      + [(.value.steps // [])[]
         | if ((.uses // "") != "" and ((.uses // "") | test($allowed) | not)) then "\($job)\tuses \(.uses), which is not on the allow-list (actions/download-artifact and actions/upload-artifact pinned by a full commit SHA, nothing else)"
           elif ((.run // "") | test($runner)) then "\($job)\truns nix, bun, bunx, npx, npm exec, npm x, git clone or gh repo clone"
           else empty end]
      + (if ((.value.env // {}) | tostring | test($anysecret; "i")) then ["\($job)\tputs a secret in the job-level env (every step, the install included, would hold it)"] else [] end)
    | .[]')
  # Wrangler: exact version, installed by a secret-free step BEFORE the first step that runs it.
  version="$(json "${workflow}" | jq -r '.env.WRANGLER_VERSION // ""')"
  [[ ${version} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    fail "${workflow}: env.WRANGLER_VERSION must be an exact x.y.z version, got '${version}'"
  wrangler_versions+=("${version}")
  json "${workflow}" | jq -e --arg anysecret "${any_secret_re}" '(.env // {}) | tostring | test($anysecret; "i") | not' >/dev/null ||
    fail "${workflow}: a secret at workflow level reaches every job, the install steps included"
  # Every deploy records the commit: wrangler outside a git checkout cannot read it, so the attribution is passed in.
  json "${workflow}" | jq -e '[.jobs[].steps[]? | (.run // "") | select(test("wrangler pages deploy"))] | all(contains("--commit-hash=\"${GITHUB_SHA}\""))' >/dev/null ||
    fail "${workflow}: a wrangler pages deploy step must pass --commit-hash=\"\${GITHUB_SHA}\" (there is no checkout in the token job, so wrangler cannot read the commit itself)"
  while IFS= read -r job; do
    json "${workflow}" | jq -e --arg job "${job}" --arg anysecret "${any_secret_re}" --arg use "${wrangler_use_re}" '
      .jobs[$job].steps as $steps
      | ([$steps | to_entries[] | select((.value.run // "") | test($use)) | .key] | first) as $use_at
      | ([$steps | to_entries[]
          | select((.value.run // "") as $r
              | ($r | contains("npm install")) and ($r | contains("wrangler@${WRANGLER_VERSION}")) and ($r | contains("--ignore-scripts"))
                and (((.value.env // {}) | tostring | test($anysecret + "|CLOUDFLARE"; "i")) | not))
          | .key] | first) as $install_at
      | $use_at == null or ($install_at != null and $install_at < $use_at)' >/dev/null ||
      fail "${workflow}: job ${job} runs wrangler without first installing it at the exact WRANGLER_VERSION (npm install --ignore-scripts wrangler@\${WRANGLER_VERSION}) in a step with no secret"
    json "${workflow}" | jq -e --arg job "${job}" '[.jobs[$job].steps[] | (.run // "") | scan("wrangler@[^ \"]*")] | all(. == "wrangler@${WRANGLER_VERSION}")' >/dev/null ||
      fail "${workflow}: job ${job} names a wrangler version other than \${WRANGLER_VERSION}"
  done <<<"${holders}"
done
if [[ -n "$(printf '%s\n' "${wrangler_versions[@]}" | sort -u | sed -n '2p')" ]]; then
  fail "the token-holding deploy workflows pin different wrangler versions (${wrangler_versions[*]}); they must agree"
fi

# 6. Casks/ and semantic-release are named only where they belong
for workflow in "${workflows[@]}"; do
  [[ ${workflow} == "${release}" || ${workflow} == "${cd_workflow}" || ${workflow} == .github/workflows/ci.yaml ]] && continue
  if rg -q 'Casks/|semantic-release|goreleaser|gh release' "${workflow}"; then
    fail "${workflow} names Casks/, semantic-release, goreleaser or gh release; only CD and Release do"
  fi
done

((status == 0)) || exit 1
echo "✅ every job of cd.yaml sits behind main-only, so a tag off main publishes nothing for commits made after this guard lands (a v* tag on a 5.0 commit made before this guard would still publish; no agent ever creates or pushes a tag); the preview deploys from rebuild/preview alone"
