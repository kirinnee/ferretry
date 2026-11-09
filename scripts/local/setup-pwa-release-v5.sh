#!/usr/bin/env bash
set -euo pipefail

# OWNER-RUN, ONCE, BEFORE THE FIRST `pwa-pages-v5.yaml` RUN: prepares the GitHub side of the 5.0 preview app
# (https://ferretry-v5.pages.dev). The owner runs it; an agent never does.
#
#   scripts/local/setup-pwa-release-v5.sh [--dry-run] [--repo <owner/name>] [--force]
#
#   --dry-run  print every step and call nothing: no gh, no openssl, no key, no prompt.
#   --repo     the repository; default: the one `gh repo view` reports for this checkout.
#   --force    replace a signing key that is already set. Without it the script stops, because replacing the key
#              strands every installed copy of the preview app until it is reinstalled (docs/pwa-release-signing.md).
#
# WHAT IT DOES (workflow: .github/workflows/pwa-pages-v5.yaml)
#   1. Creates two GitHub environments, each with a deployment-branch rule that allows `rebuild/5.0` ONLY, BEFORE the
#      first run can ask for them: `pwa-release-v5` (the signing key) and `pwa-deploy-v5` (the Cloudflare credentials).
#      They are two environments so the job that signs never holds the Cloudflare token and the job that deploys never
#      holds the key (docs/pwa-release-signing.md).
#   2. Generates an Ed25519 key in a 0600 file inside a 0700 temp directory and sets it as the environment secret
#      PWA_RELEASE_SIGNING_KEY, through STDIN. The private key is never printed, logged, put in an argument or an
#      environment variable, and the temp directory is removed on every exit.
#   0. FIRST (before anything is created) asks for the Cloudflare values and checks for a terminal.
#   3. REQUIRES a Cloudflare API token and account id for the `ferretry-v5` Pages project, and sets them in
#      `pwa-deploy-v5` through hidden prompts and stdin, never argv and never echoed. A blank answer, or no terminal,
#      stops the script: there is no fallback. They have names of their own (CLOUDFLARE_PAGES_V5_API_TOKEN and
#      CLOUDFLARE_PAGES_V5_ACCOUNT_ID) that no repository-level secret has, so the deploy job can never run
#      rebuild/5.0's wrangler holding production's account token. Make the token in the Cloudflare dashboard with
#      ONLY "Account > Cloudflare Pages > Edit", limited to the one account; it is not production's token.
#   4. Prints the PUBLIC key and the one next step: commit it as packages/app/release-signing-key.preview.pub on
#      rebuild/5.0 (the build refuses without it, so the preview cannot ship unsigned or under the wrong key).
#
# It reads no credential file. `gh` finds its own login; this script never opens it.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

dry_run=0
force=0
repo="${GH_REPO:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
  --dry-run) dry_run=1 && shift ;;
  --force) force=1 && shift ;;
  --repo) repo="${2:-}" && shift 2 ;;
  *) echo "❌ usage: setup-pwa-release-v5.sh [--dry-run] [--repo <owner/name>] [--force]" >&2 && exit 64 ;;
  esac
done

branch="rebuild/5.0"
signing_env="pwa-release-v5"
deploy_env="pwa-deploy-v5"
key_secret="PWA_RELEASE_SIGNING_KEY"
policy='{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'

# ─── the repository ────────────────────────────────────────────────────────────────────────────
if [[ ${dry_run} -eq 1 ]]; then
  repo="${repo:-<owner/name from gh repo view>}"
  echo "📝 dry run: nothing below is executed"
else
  command -v gh >/dev/null || { echo "❌ gh is not installed" >&2 && exit 1; }
  command -v openssl >/dev/null || { echo "❌ openssl is not installed" >&2 && exit 1; }
  repo="${repo:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
fi
echo "📝 repository: ${repo}"

# ─── 0. everything that can fail on the person comes BEFORE anything is created, set or generated ──
# The terminal check and both Cloudflare prompts first, so a blank answer, Ctrl-C or no terminal leaves GitHub as it was
# (no signing key set whose public half was never printed). The values live only in two variables, never in argv.
cf_secrets=(CLOUDFLARE_PAGES_V5_API_TOKEN CLOUDFLARE_PAGES_V5_ACCOUNT_ID)
cf_token=""
cf_account=""
if [[ ${dry_run} -eq 1 ]]; then
  for secret in "${cf_secrets[@]}"; do
    echo "⚙️  [dry-run] would REQUIRE, with a hidden prompt and BEFORE any key is made, ${secret} (a blank answer or no terminal stops here)"
  done
else
  set +x # a traced run would print the values below
  if [[ ! -t 0 ]]; then
    echo "❌ no terminal for the Cloudflare prompts, and there is no fallback to a repository secret; run this script in a terminal" >&2
    exit 1
  fi
  read -r -s -p "Paste CLOUDFLARE_PAGES_V5_API_TOKEN for ${deploy_env} (hidden; required; a Pages-only token for ferretry-v5): " cf_token
  echo
  [[ -n ${cf_token} ]] || { echo "❌ CLOUDFLARE_PAGES_V5_API_TOKEN is required: the deploy never falls back to a repository-level Cloudflare token" >&2 && exit 1; }
  read -r -s -p "Paste CLOUDFLARE_PAGES_V5_ACCOUNT_ID for ${deploy_env} (hidden; required): " cf_account
  echo
  [[ -n ${cf_account} ]] || { echo "❌ CLOUDFLARE_PAGES_V5_ACCOUNT_ID is required" >&2 && exit 1; }
fi

# ─── 1. the environments, restricted to the branch before anything can run ──────────────────────
for environment in "${signing_env}" "${deploy_env}"; do
  echo "⚙️  environment ${environment}: deployment branches limited to ${branch}"
  if [[ ${dry_run} -eq 1 ]]; then
    echo "   [dry-run] gh api --method PUT repos/${repo}/environments/${environment} --input - <<< '${policy}'"
    echo "   [dry-run] gh api repos/${repo}/environments/${environment}/deployment-branch-policies  (delete any rule but ${branch}, add it if absent)"
    continue
  fi
  gh api --method PUT "repos/${repo}/environments/${environment}" --input - <<<"${policy}" >/dev/null
  policies="$(gh api "repos/${repo}/environments/${environment}/deployment-branch-policies" --jq '.branch_policies[] | "\(.id)\t\(.name)"')"
  present=0
  while IFS=$'\t' read -r id name; do
    [[ -n ${id} ]] || continue
    if [[ ${name} == "${branch}" ]]; then
      present=1
    else
      echo "🔁 removing the rule for '${name}' from ${environment}"
      gh api --method DELETE "repos/${repo}/environments/${environment}/deployment-branch-policies/${id}" >/dev/null
    fi
  done <<<"${policies}"
  if [[ ${present} -eq 0 ]]; then
    gh api --method POST "repos/${repo}/environments/${environment}/deployment-branch-policies" \
      --input - <<<"{\"name\":\"${branch}\",\"type\":\"branch\"}" >/dev/null
  fi
  echo "✅ ${environment}: only ${branch} may deploy to it"
done

# ─── 2. the signing key ────────────────────────────────────────────────────────────────────────
if [[ ${dry_run} -eq 1 ]]; then
  echo "⚙️  [dry-run] would stop if ${key_secret} already exists in ${signing_env} (unless --force)"
  echo "⚙️  [dry-run] openssl genpkey -algorithm ed25519 into a 0600 file in a 0700 temp dir; the private key is never printed"
  echo "⚙️  [dry-run] gh secret set ${key_secret} --env ${signing_env} --repo ${repo} < <that file>"
  echo "⚙️  [dry-run] the temp dir is removed by a trap on every exit"
  public_key="<the public key is printed here>"
else
  existing="$(gh secret list --env "${signing_env}" --repo "${repo}" --json name --jq '.[].name')"
  if grep -qx "${key_secret}" <<<"${existing}" && [[ ${force} -eq 0 ]]; then
    echo "❌ ${key_secret} is already set in ${signing_env}; replacing it strands installed copies of the preview app. Re-run with --force to replace it." >&2
    exit 1
  fi
  key_dir="$(mktemp -d)"
  trap 'rm -rf "${key_dir}"' EXIT
  chmod 700 "${key_dir}"
  key_file="${key_dir}/release-signing-key.pem"
  (umask 077 && openssl genpkey -algorithm ed25519 -out "${key_file}")
  chmod 600 "${key_file}"
  echo "📤 setting ${key_secret} in ${signing_env} (through stdin)"
  gh secret set "${key_secret}" --env "${signing_env}" --repo "${repo}" <"${key_file}"
  public_key="$(openssl pkey -in "${key_file}" -pubout)"
  rm -rf "${key_dir}"
  echo "✅ the signing key is set; the private half is gone from this machine"
  # Printed NOW, so a later failure never leaves a key set whose public half was never shown.
  echo "📝 the preview's PUBLIC release key (also printed at the end):"
  echo "${public_key}"
fi

# ─── 3. the Cloudflare credentials, set from the variables read in step 0 ───────────────────────
if [[ ${dry_run} -eq 1 ]]; then
  for secret in "${cf_secrets[@]}"; do
    echo "⚙️  [dry-run] would set ${secret} in ${deploy_env} through stdin: printf '%s' <value> | gh secret set ${secret} --env ${deploy_env}"
  done
else
  # `printf` is a shell builtin, so no process's arguments carry a value.
  printf '%s' "${cf_token}" | gh secret set CLOUDFLARE_PAGES_V5_API_TOKEN --env "${deploy_env}" --repo "${repo}"
  echo "✅ CLOUDFLARE_PAGES_V5_API_TOKEN set in ${deploy_env}"
  printf '%s' "${cf_account}" | gh secret set CLOUDFLARE_PAGES_V5_ACCOUNT_ID --env "${deploy_env}" --repo "${repo}"
  echo "✅ CLOUDFLARE_PAGES_V5_ACCOUNT_ID set in ${deploy_env}"
  unset cf_token cf_account
fi

# ─── 4. the public key and the next step ───────────────────────────────────────────────────────
echo "📝 the preview's PUBLIC release key:"
echo "${public_key}"
echo "📝 NEXT STEP: save it as packages/app/release-signing-key.preview.pub on ${branch}, commit and push."
echo "   The first push to ${branch} after that builds, signs and deploys https://ferretry-v5.pages.dev."
