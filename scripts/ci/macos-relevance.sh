#!/usr/bin/env bash
set -euo pipefail

# Which of the optional jobs of the REALWORLD workflow has anything to prove — the three macOS ones, and
# the Linux tmux 3.8 leg? Writes to $GITHUB_OUTPUT:
#
#   containment=true|false   Containment (macOS)         scripts/ci/darwin-confinement.sh
#   safari=true|false        Sandbox Shell (Safari)      scripts/ci/safari-render-proof.sh
#   harness=true|false       Harness Contract (macos-15) packages/fleet/tests/contract/run.sh pinned
#   harness_os=[...]         the `os` matrix of `Harness Contract`: always ubuntu-latest, plus macos-15
#                            when `harness` is true
#   tmux38=true|false        Integration Tests (tmux 3.8)  the tmux-driven integration groups on tmux 3.8
#
# `Smoke darwin-arm64` is NOT decided here: it runs the shipped binary and almost every pull request
# changes the binary, so it stays on every run.
#
# Only 5 macOS jobs run at once across the whole GitHub account, and a run used 4 of them, so two
# overlapping pull requests queued (p90 6 minutes, worst 74). A pull request that touches none of a
# job's inputs now leaves that job out. `main`, the nightly and `workflow_dispatch` ALWAYS run all three,
# so a path list that missed an input shows up one merge later, never as a proof that was skipped. The jobs
# live in `.github/workflows/realworld.yaml` and gate no release (docs/standards/ci-cd, "Release gating"),
# so what a miss costs is an issue, not a blocked release.
#
# WHY A JOB AND NOT `paths`/`paths-ignore`. The same reason as scripts/ci/e2e-relevance.sh: a
# workflow-level filter would skip the whole workflow, and a job that is skipped by `if:` reports as
# skipped, which GitHub (and scripts/safe-merge.sh) count as passed. There is no branch protection to
# configure and no stub check to keep in step.
#
# It fails open: any doubt — not a pull request, an unreadable file list, an empty one — runs all
# three. The path lists below are deliberately generous: each is what the job's script reads, plus the
# package manifests and the toolchain, never less. scripts/validate/macos-relevance.sh holds the lists
# to the scripts: every test path a job runs must decide that job `true`.
#
# For a local check, MACOS_RELEVANCE_FILES names a file listing the changed paths, one per line;
# GITHUB_EVENT_NAME=pull_request is then implied.

out="${GITHUB_OUTPUT:-/dev/stdout}"

# Everything that changes how ANY macOS job builds or runs: the toolchain (flake, nix/), the
# workflows and the composite actions that call these jobs, the lockfile and manifests `setup.sh`
# installs from, and the test configs.
common='^(flake\.(nix|lock)|nix/|\.github/(workflows/realworld\.yaml|actions/)|bun\.lock|package\.json|bunfig[^/]*\.toml|tsconfig[^/]*\.json|scripts/(ci|local)/setup\.sh)'

# The daemon's file viewer (`session`, `filesystem`), its POSIX pinner (`pins`), git, the process
# inventory (`migrate`, `process`), pane identity (`tmux`, `terminal`), the file-event hub, and the
# barrels `durable-terminal-pane-reap` loads whole; `fy attach`'s tmux attacher; the protocol's process
# incarnation; the fleet provisioner's destination side (its descriptor calls and everything its two tests load —
# the guard, the journal, the provisioner, the plan types); and the integration tests and support those files are proved by.
containment="${common}|^scripts/ci/darwin-confinement\.sh$"
containment+='|^packages/daemon/(package\.json|src/(adapters|lib)/(session|filesystem|pins|git|worktrees|migrate|process|tmux|terminal|file-events)/|src/(adapters|lib)/index\.ts|src/lib/tmux-attacher\.ts|tests/integration/(session|migrate|file-events|support|process)/)'
containment+='|^packages/protocol/(package\.json|src/adapters/process-incarnation|tests/integration/process-incarnation)'
containment+='|^packages/cli/(package\.json|src/adapters/reads/|tests/integration/reads/)'
containment+='|^packages/fleet/(package\.json|src/|tests/integration/(descriptor-calls|file-provisioner-destination-fence|file-shared-history)\.test\.ts)'

# The fy-render sandbox shell: the probe's own harness, the build that generates the shell, the policy
# it reads (`public/_headers`), the render library the probe imports, and the journey fixture.
safari="${common}|^scripts/ci/safari-render-proof\.sh$"
safari+='|^packages/pwa/(package\.json|harness/fy-render-safari/|scripts/|public/_headers|src/lib/(fy-render|references)|src/.*fy-render|tests/fixtures/fy-render-journey\.ts)'

# The pinned Claude/Codex harnesses, the account model that drives them (`packages/fleet`), the
# `VERIFIED_HARNESS_VERSIONS` the runner cross-checks, and the daemon's transcript conversion and
# question projection (the hook's file read beside the transcript) that the contract suite proves against
# the real binaries.
harness="${common}|^scripts/ci/harness-contract-report\.sh$"
harness+='|^packages/fleet/'
harness+='|^packages/protocol/(package\.json|src/lib/harness-update\.ts)'
harness+='|^packages/daemon/(package\.json|tests/contract/|src/(adapters|lib)/transcript/|src/lib/migrate/)'
harness+='|^packages/daemon/src/(adapters|lib)/session/question/'

# The 3.8 leg (nix/env.nix says why CI pins 3.7b): anything of the daemon's named for tmux, the session
# lifecycle and health code that reads dead panes, their integration tests, and how the groups run.
tmux38="${common}|^scripts/ci/test\.sh$|^config/test-groups\.json$"
tmux38+='|^packages/daemon/src/.*tmux'
tmux38+='|^packages/daemon/src/(adapters|lib)/session/(lifecycle|health)/'
tmux38+='|^packages/daemon/tests/integration/(tmux|session/lifecycle)/'

emit() {
  local why="$1"
  {
    echo "containment=$2"
    echo "safari=$3"
    echo "harness=$4"
    if [ "$4" = true ]; then
      echo 'harness_os=["ubuntu-latest","macos-15"]'
    else
      echo 'harness_os=["ubuntu-latest"]'
    fi
    echo "tmux38=$5"
  } >>"${out}"
  echo "🧭 optional jobs: containment=$2 safari=$3 harness=$4 tmux38=$5 — ${why}"
  exit 0
}

[ "${MACOS_RELEVANCE_FILES:-}" = "" ] && [ "${GITHUB_EVENT_NAME:-}" != "pull_request" ] &&
  emit "not a pull request (${GITHUB_EVENT_NAME:-local}): every proof runs" true true true true
[ "${MACOS_RELEVANCE_FILES:-}" = "" ] && [ -z "${PR_NUMBER:-}" ] &&
  emit "no pull request number" true true true true

if [ -n "${MACOS_RELEVANCE_FILES:-}" ]; then
  files="$(cat "${MACOS_RELEVANCE_FILES}")"
else
  set +e
  files="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/files" --jq '.[].filename')"
  listed=$?
  set -e
  [ "${listed}" -ne 0 ] && emit "the pull request's files could not be listed" true true true true
fi
[ -z "${files}" ] && emit "the pull request lists no files" true true true true

matches() { grep -Eq "$1" <<<"${files}" && echo true || echo false; }

c="$(matches "${containment}")"
s="$(matches "${safari}")"
h="$(matches "${harness}")"
t="$(matches "${tmux38}")"
emit "$(wc -l <<<"${files}") changed files" "${c}" "${s}" "${h}" "${t}"
