#!/usr/bin/env bash
set -euo pipefail

# Pre-push gate: a pushed branch must CONTAIN the tip of its base. Run by the `a-pre-push-fresh` hook on the
# `pre-push` stage, which pre-commit feeds through PRE_COMMIT_LOCAL_BRANCH, PRE_COMMIT_REMOTE_BRANCH and
# PRE_COMMIT_TO_REF (the pushed commit). Docs: docs/standards/linting/index.md ("Pushing a branch that is behind").

usage() {
  cat <<'EOF'
usage: pre-push-fresh.sh [--help]
Refuses a push of a branch that does not contain its base's tip (git merge-base --is-ancestor origin/<base> <pushed sha>).
The branch is the one pushed TO (the remote ref), and the commit is the one pushed (a branch, `HEAD` or a raw sha alike).
Base: `git config branch.<name>.ferretry-base`, else the branch it was cut from (its upstream, when that is another branch),
else the nearest of origin's long-lived branches (origin/HEAD, main, rebuild/<digit>*, release/<digit>*): the one it forked from last.
When no base can be told with confidence the push is allowed with a warning.
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

# Only a branch update is gated: a tag, a delete, or a run outside a push (no refs given) is allowed. The
# DESTINATION decides: `git push origin <sha>:refs/heads/<branch>` names no local branch at all.
case "${local_ref}" in refs/tags/* | refs/notes/* | refs/remotes/*) exit 0 ;; esac
case "${remote_ref}" in refs/heads/*) ;; *) exit 0 ;; esac
[ -z "${pushed_sha}" ] && exit 0
case "${pushed_sha}" in *[!0]*) ;; *) exit 0 ;; esac # all zeros: a delete

pushed_commit="$(git rev-parse --verify --quiet "${pushed_sha}^{commit}" 2>/dev/null || true)"
[ -z "${pushed_commit}" ] && exit 0

dest="${remote_ref#refs/heads/}"
# The local branch (when the push names one) carries the config; a sha refspec falls back to the destination's.
branch="${dest}"
case "${local_ref}" in refs/heads/*) branch="${local_ref#refs/heads/}" ;; esac

# Candidate order of preference for the base; a recorded or inherited one is certain, a guess from the graph is not.
bases=()
base="$(git config --get "branch.${branch}.ferretry-base" 2>/dev/null || true)"
[ -z "${base}" ] && [ "${branch}" != "${dest}" ] && base="$(git config --get "branch.${dest}.ferretry-base" 2>/dev/null || true)"
if [ -z "${base}" ]; then
  # A branch cut from `origin/<base>` tracks it until its first `push -u`; a branch tracking its own name says nothing.
  upstream="$(git config --get "branch.${branch}.merge" 2>/dev/null || true)"
  upstream="${upstream#refs/heads/}"
  if [ "$(git config --get "branch.${branch}.remote" 2>/dev/null || true)" = "origin" ] && [ "${upstream}" != "${branch}" ] && [ "${upstream}" != "${dest}" ]; then
    base="${upstream}"
  fi
fi
base="${base#origin/}"

if [ -n "${base}" ]; then
  bases=("${base}")
else
  # No setting: the base is the long-lived branch of origin that this branch forked from last, found from the refs
  # already fetched (no network, no per-user setup). Candidates: origin/HEAD's branch, main, and the version-named
  # rebuild/<digit>* and release/<digit>* branches. Never every rebuild/* ref: origin holds one per PR (1,000+), and
  # comparing each fork point with every other made a push hang for minutes.
  default="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  default="${default#origin/}"
  candidates=()
  while IFS= read -r name; do
    [ -z "${name}" ] || [ "${name}" = "${dest}" ] && continue
    case " ${candidates[*]:-} " in *" ${name} "*) continue ;; esac
    candidates+=("${name}")
  done < <(
    {
      [ -n "${default}" ] && echo "${default}"
      echo main
      git for-each-ref --format='%(refname:strip=3)' 'refs/remotes/origin/rebuild/[0-9]*' 'refs/remotes/origin/release/[0-9]*' 2>/dev/null
    }
  )
  found=()
  merge_bases=()
  for name in ${candidates[@]+"${candidates[@]}"}; do
    tip="$(git rev-parse --verify --quiet "refs/remotes/origin/${name}^{commit}" 2>/dev/null || true)"
    [ -z "${tip}" ] && continue
    fork="$(git merge-base "${tip}" "${pushed_commit}" 2>/dev/null || true)"
    [ -z "${fork}" ] && continue
    found+=("${name}")
    merge_bases+=("${fork}")
  done
  # The nearest are those whose fork point no other candidate's fork point descends from. Several remain when the
  # graph cannot tell them apart; the push is then refused only if it is behind every one of them.
  index=0
  for name in ${found[@]+"${found[@]}"}; do
    fork="${merge_bases[${index}]}"
    nearest=1
    other=0
    for other_fork in ${merge_bases[@]+"${merge_bases[@]}"}; do
      if [ "${other_fork}" != "${fork}" ] && git merge-base --is-ancestor "${fork}" "${other_fork}" 2>/dev/null; then
        nearest=0
        break
      fi
      other=$((other + 1))
    done
    [ "${nearest}" = "1" ] && bases+=("${name}")
    index=$((index + 1))
  done
  if [ "${#bases[@]}" -eq 0 ] && [ -n "${default}" ] && [ "${default}" != "${dest}" ]; then
    bases=("${default}")
  fi
fi

if [ "${#bases[@]}" -eq 0 ]; then
  echo "⚠️  pre-push: could not tell which branch ${dest} is based on; not checking that it is up to date." >&2
  exit 0
fi

# The base itself (and the branch it is pushed to) is never "behind" itself.
for name in "${bases[@]}"; do
  [ "${dest}" = "${name}" ] && exit 0
  [ "${branch}" = "${name}" ] && [ "${branch}" = "${dest}" ] && exit 0
done

# Quiet fetch; never block on the network.
if ! GIT_TERMINAL_PROMPT=0 timeout 20 git fetch --quiet origin "${bases[@]}" </dev/null >/dev/null 2>&1; then
  echo "⚠️  pre-push: could not fetch origin/${bases[0]}; not checking that ${dest} contains it." >&2
  exit 0
fi

known=0
for name in "${bases[@]}"; do
  base_tip="$(git rev-parse --verify --quiet "refs/remotes/origin/${name}^{commit}" || true)"
  [ -z "${base_tip}" ] && continue
  known=1
  git merge-base --is-ancestor "${base_tip}" "${pushed_commit}" && exit 0
done

if [ "${known}" = "0" ]; then
  echo "⚠️  pre-push: origin/${bases[0]} is unknown; not checking that ${dest} contains it." >&2
  exit 0
fi

echo "❌ ${dest} is behind ${bases[0]}: rebase onto origin/${bases[0]} first (or merge it on a shared branch). Set FY_ALLOW_BEHIND_PUSH=1 to push anyway." >&2
exit 1
