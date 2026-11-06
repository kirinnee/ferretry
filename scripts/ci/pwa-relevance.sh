#!/usr/bin/env bash
set -euo pipefail

# Does this run of `CI` have anything for the PWA browser gate (`pwa-screenshot`) to prove? Writes
# `run=true|false` to $GITHUB_OUTPUT.
#
# `pwa-screenshot` is three real-Chrome walks of the PWA (Settings geometry on a 2x4, the full gallery
# once per viewport on two 4x8) and about a fifth of the Namespace bill, yet roughly one pull request in
# four changes nothing the walk reads: a daemon-only, CLI-only or docs-only change. Those leave the gate
# out. It is SKIPPED, and a skipped check counts as passed (GitHub reads
# it so), so no stub check and no branch-protection change is needed.
#
# WHY A JOB AND NOT `paths-ignore`. The reason scripts/ci/e2e-relevance.sh gives: a workflow that is
# filtered out never starts, and CI's other sixteen jobs must run on every pull request. Deciding inside
# the workflow keeps exactly one status per job.
#
# WHAT THE GATE READS, traced from the code (scripts/validate/pwa-relevance.sh holds this list to it):
#
#   packages/pwa/      the harness (`harness/screenshot.ts` bundles `harness/main.tsx`), every file the
#                      bundle imports from `src/`, `tailwind.config.ts`, `public/`, the fonts
#   packages/protocol/ imported by the PWA, ~700 files of the bundle
#   packages/relay/    imported by the PWA (the carrier and the hosted-relay directory)
#   packages/fleet/    imported by the PWA (the model catalogs)
#
# `@ferretry/protocol` is also what `fleet` and `relay` import, so those four are the workspace closure
# of the PWA. Everything else the job needs is the toolchain it builds with and the workflows and scripts
# that run it: the flake and `nix/` (Chrome and bun come from there), `bun.lock` and every manifest,
# bunfig and tsconfig, `.github/**`, `scripts/ci/**` (this job's own scripts and the shared setup) and
# `scripts/local/setup.sh` (`bun install`).
#
# The list is deliberately generous: a path that is not certainly irrelevant is relevant. A miss costs a
# browser regression that reaches `main`, where the gate always runs; a false hit costs one run. `main`,
# the nightly and `workflow_dispatch` ALWAYS run it.
#
# It fails open: any doubt — not a pull request, an unreadable file list, an empty one — runs the gate.
#
# For a local check, PWA_RELEVANCE_FILES names a file listing the changed paths, one per line;
# GITHUB_EVENT_NAME=pull_request is then implied.

out="${GITHUB_OUTPUT:-/dev/stdout}"

relevant='^(packages/(pwa|protocol|relay|fleet)/'
relevant+='|flake\.(nix|lock)$|nix/|bun\.lock$|(.*/)?package\.json$|(.*/)?bunfig[^/]*\.toml$|(.*/)?tsconfig[^/]*$'
relevant+='|\.github/|scripts/ci/|scripts/local/setup\.sh$)'

decide() {
  echo "run=$1" >>"${out}"
  echo "🧭 pwa browser gate: run=$1 — $2"
  exit 0
}

if [ -z "${PWA_RELEVANCE_FILES:-}" ]; then
  [ "${GITHUB_EVENT_NAME:-}" != "pull_request" ] && decide true "not a pull request (${GITHUB_EVENT_NAME:-local})"
  [ -z "${PR_NUMBER:-}" ] && decide true "no pull request number"

  set +e
  files="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/files" --jq '.[] | .filename, (.previous_filename // empty)')"
  listed=$?
  total="$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}" --jq '.changed_files')"
  counted=$?
  set -e
  [ "${listed}" -ne 0 ] && decide true "the pull request's files could not be listed"
  [ "${counted}" -ne 0 ] && decide true "the pull request's file count could not be read"
  # The files API ends at 3000 files without saying so: a larger pull request has paths the list never showed.
  case "${total}" in '' | *[!0-9]*) decide true "the pull request's file count is not a number (${total})" ;; esac
  [ "${total}" -ge 3000 ] && decide true "the pull request changes ${total} files, more than the files API lists"
  [ "${total}" -gt "$(wc -l <<<"${files}")" ] && decide true "the pull request changes ${total} files but only $(wc -l <<<"${files}") were listed"
else
  files="$(cat "${PWA_RELEVANCE_FILES}")"
fi
[ -z "${files}" ] && decide true "the pull request lists no files"

hits="$(grep -E "${relevant}" <<<"${files}" || true)"
[ -z "${hits}" ] && decide false "none of the $(wc -l <<<"${files}") changed files is read by the gate"
decide true "$(wc -l <<<"${hits}") of $(wc -l <<<"${files}") changed files are read by the gate, e.g. $(head -1 <<<"${hits}")"
