#!/usr/bin/env bash
set -euo pipefail

# Pre-push gate: a pushed branch must CONTAIN the tip of its base. Run by the `a-pre-push-fresh` hook on the
# `pre-push` stage, which pre-commit feeds through PRE_COMMIT_LOCAL_BRANCH, PRE_COMMIT_REMOTE_BRANCH and
# PRE_COMMIT_TO_REF (the pushed commit). Docs: docs/standards/linting/index.md ("Pushing a branch that is behind").

usage() {
  cat <<'EOF'
usage: pre-push-fresh.sh [--help]
Refuses a push of a branch that does not contain its base's tip (git merge-base --is-ancestor origin/<base> <pushed sha>).
Base: `git config branch.<name>.ferretry-base`, else the branch it was cut from (its upstream, when that is another branch), else origin/HEAD's branch.
Tag pushes, branch deletes and the base branch itself are skipped; a failed fetch (offline) allows the push with a warning.
Set FY_ALLOW_BEHIND_PUSH=1 to push anyway.
EOF
}

case "${1:-}" in
-h | --help)
  usage
  exit 0
  ;;
esac

[ "${FY_ALLOW_BEHIND_PUSH:-}" = "1" ] && exit 0

local_ref="${PRE_COMMIT_LOCAL_BRANCH:-}"
remote_ref="${PRE_COMMIT_REMOTE_BRANCH:-}"
pushed_sha="${PRE_COMMIT_TO_REF:-}"

# Only a branch update is gated: a tag, a delete, or a run outside a push (no refs given) is allowed.
case "${local_ref}" in refs/heads/*) ;; *) exit 0 ;; esac
case "${remote_ref}" in refs/heads/*) ;; *) exit 0 ;; esac
[ -z "${pushed_sha}" ] && exit 0

branch="${local_ref#refs/heads/}"

base="$(git config --get "branch.${branch}.ferretry-base" 2>/dev/null || true)"
if [ -z "${base}" ]; then
  # A branch cut from `origin/<base>` tracks it until its first `push -u`; a branch tracking its own name says nothing.
  upstream="$(git config --get "branch.${branch}.merge" 2>/dev/null || true)"
  upstream="${upstream#refs/heads/}"
  [ "$(git config --get "branch.${branch}.remote" 2>/dev/null || true)" = "origin" ] && [ "${upstream}" != "${branch}" ] && base="${upstream}"
fi
if [ -z "${base}" ]; then
  base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  base="${base#origin/}"
fi
base="${base#origin/}"
[ -z "${base}" ] && exit 0

# The base itself (and the branch it is pushed to) is never "behind" itself.
[ "${branch}" = "${base}" ] && exit 0
[ "${remote_ref#refs/heads/}" = "${base}" ] && exit 0

# Quiet fetch; never block on the network.
if ! GIT_TERMINAL_PROMPT=0 timeout 20 git fetch --quiet origin "${base}" </dev/null >/dev/null 2>&1; then
  echo "⚠️  pre-push: could not fetch origin/${base}; not checking that ${branch} contains it." >&2
  exit 0
fi

base_tip="$(git rev-parse --verify --quiet "refs/remotes/origin/${base}^{commit}" || true)"
if [ -z "${base_tip}" ]; then
  echo "⚠️  pre-push: origin/${base} is unknown; not checking that ${branch} contains it." >&2
  exit 0
fi

if git merge-base --is-ancestor "${base_tip}" "${pushed_sha}"; then
  exit 0
fi

echo "❌ ${branch} is behind ${base}: rebase onto origin/${base} first (or merge it on a shared branch). Set FY_ALLOW_BEHIND_PUSH=1 to push anyway." >&2
exit 1
