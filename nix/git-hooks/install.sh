#!/usr/bin/env bash
set -euo pipefail

# Installs this repository's Git hook launchers. The devshell's shellHook runs it, so it runs on
# every `direnv exec` in every one of this repository's mandatory linked worktrees, concurrently.
#
# It installs the same launchers in TWO places, and both are load-bearing.
#
# The common directory's `hooks/` is the baseline. Git resolves it from any linked worktree, so a
# worktree nobody has ever opened a devshell in — every worktree `packages/daemon` creates — still
# has working hooks the moment it exists.
#
# A private per-worktree directory is what makes this worktree's linting survive its neighbours. A
# worktree on a branch cut before this change still runs `pre-commit install` without `-f` on every
# entry, which demotes whatever occupies the shared path and leaves a launcher pair that fails
# EVERY commit. On this repository that was measured at twenty takeovers a minute. A worktree-scoped
# `core.hooksPath` puts this worktree out of that fight without taking anything from the others.
#
# The launchers themselves name no worktree and no revision; the generated `.pre-commit-config.yaml`
# they resolve at run time is per-worktree, so each checkout lints at its own revision.
#
# Every step is a no-op once the state is already right, so an ordinary read-only command in a
# settled worktree writes nothing at all. Only steps that do change something are announced — this
# runs before every command in the repository.

launcher_dir="${1:-}"
config_source="${2:-}"
pre_commit_source="${3:-}"
[ -z "${launcher_dir}" ] && echo "❌ git hooks: launcher directory argument missing" >&2 && exit 2
[ -z "${config_source}" ] && echo "❌ git hooks: generated pre-commit config argument missing" >&2 && exit 2
[ -z "${pre_commit_source}" ] && echo "❌ git hooks: pre-commit package argument missing" >&2 && exit 2

# A devshell must still open where there is no repository to install into.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

worktree_root="$(git rev-parse --show-toplevel)"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
common_dir="${common_dir%/}"
worktree_git_dir="$(git rev-parse --path-format=absolute --git-dir)"
worktree_git_dir="${worktree_git_dir%/}"
hooks_dir="${common_dir}/hooks"
worktree_hooks_dir="${worktree_git_dir}/ferretry-hooks"
lock_dir="${common_dir}/ferretry-git-hooks.lock"
pre_commit_link="${common_dir}/ferretry-pre-commit"
config_link="${worktree_root}/.pre-commit-config.yaml"

# Linking the generated config per worktree is what makes a worktree lint at its own revision
# instead of at whichever worktree entered a devshell last.
if [ -e "${config_link}" ] && [ ! -L "${config_link}" ]; then
  echo "❌ git hooks: ${config_link} is a real file, not a generated link; refusing to replace it" >&2
  exit 1
fi
if [ "$(readlink "${config_link}" 2>/dev/null || true)" != "${config_source}" ]; then
  # An indirect GC root keeps the generated config alive between builds; a config outside the store
  # (a test harness driving this script) has nothing to pin and just gets the link.
  case "${config_source}" in
  /nix/store/*)
    nix-store --add-root "${config_link}" --indirect --realise "${config_source}" >/dev/null
    ;;
  *)
    ln -fs "${config_source}" "${config_link}"
    ;;
  esac
fi

# Per-worktree isolation needs `extensions.worktreeConfig`, and enabling that makes `core.bare` and
# `core.worktree` from the shared config apply to every worktree at once. Neither is set in an
# ordinary clone of this repository; where one IS set, migrating it is the repository owner's call,
# not a shellHook's, so isolation is skipped and the shared baseline carries the worktree.
isolation_blocked=""
if [ "$(git config --local --get core.bare 2>/dev/null || echo false)" != "false" ]; then
  isolation_blocked="core.bare is set"
fi
if [ -n "$(git config --local --get core.worktree 2>/dev/null || true)" ]; then
  isolation_blocked="core.worktree is set"
fi

# Decide whether anything needs to change while still holding no lock and writing nothing.
local_hooks_path="$(git config --local --get core.hooksPath 2>/dev/null || true)"
worktree_hooks_path="$(git config --worktree --get core.hooksPath 2>/dev/null || true)"

needs_work=""
if [ "${local_hooks_path}" != "${hooks_dir}" ]; then
  needs_work="yes"
fi
if [ -z "${isolation_blocked}" ] && [ "${worktree_hooks_path}" != "${worktree_hooks_dir}" ]; then
  needs_work="yes"
fi
if [ ! -e "${pre_commit_link}/bin/pre-commit" ]; then
  needs_work="yes"
fi
for launcher in "${launcher_dir}"/*; do
  hook_type="$(basename "${launcher}")"
  cmp -s "${launcher}" "${hooks_dir}/${hook_type}" && [ -x "${hooks_dir}/${hook_type}" ] || needs_work="yes"
  if [ -z "${isolation_blocked}" ]; then
    cmp -s "${launcher}" "${worktree_hooks_dir}/${hook_type}" &&
      [ -x "${worktree_hooks_dir}/${hook_type}" ] || needs_work="yes"
  fi
done
if [ -z "${needs_work}" ]; then
  exit 0
fi

# Serialise the common-directory mutation. Every worktree runs this script and `direnv exec` runs it
# once per command, so concurrent entries are the normal case, not the exception. `mkdir` is the
# portable atomic lock — macOS has no flock(1).
waited=0
until mkdir "${lock_dir}" 2>/dev/null; do
  if [ "${waited}" -ge 100 ]; then
    echo "📝 git hooks: ${lock_dir} is held elsewhere; leaving the install to that shell" >&2
    exit 0
  fi
  # A shell killed mid-install would otherwise block every future entry for good.
  if [ -n "$(find "${lock_dir}" -maxdepth 0 -mmin +5 2>/dev/null || true)" ]; then
    rmdir "${lock_dir}" 2>/dev/null || true
  fi
  sleep 0.1
  waited=$((waited + 1))
done
trap 'rmdir "${lock_dir}" 2> /dev/null || true' EXIT

# The pinned fallback the launcher uses when a commit is made outside a devshell — from an editor,
# say — and PATH holds no pre-commit this repository put there. Written only when it is missing or
# dangling: rewriting it every time a worktree on another revision entered would put the
# last-writer-wins churn straight back, and any pre-commit runs any worktree's own config.
if [ ! -e "${pre_commit_link}/bin/pre-commit" ]; then
  rm -f "${pre_commit_link}"
  case "${pre_commit_source}" in
  /nix/store/*)
    nix-store --add-root "${pre_commit_link}" --indirect --realise "${pre_commit_source}" >/dev/null
    ;;
  *)
    ln -s "${pre_commit_source}" "${pre_commit_link}"
    ;;
  esac
  echo "📝 git hooks: pinned ${pre_commit_link} for commits made outside a devshell"
fi

generated_launcher='^# (File generated by pre-commit|Ferretry shared Git hook launcher)'

install_targets=("${hooks_dir}")
if [ -z "${isolation_blocked}" ]; then
  mkdir -p "${worktree_hooks_dir}"
  install_targets+=("${worktree_hooks_dir}")
fi

for target in "${install_targets[@]}"; do
  # A staged launcher from a shell that died holding the lock. Nothing else may be mid-write: this
  # script is the only writer of these names and it holds the lock.
  rm -f "${target}"/.ferretry-*

  for launcher in "${launcher_dir}"/*; do
    hook_type="$(basename "${launcher}")"
    installed="${target}/${hook_type}"
    legacy="${installed}.legacy"

    # pre-commit's migration mode moves whatever occupies the hook path to `<hook>.legacy` and calls
    # it. Aim that at pre-commit's own launcher and it calls itself; the tool detects the
    # self-reference and aborts, so every commit fails with `bug: pre-commit's script is installed
    # in migration mode` — including one whose subject the gate has just called Passed. Drop those.
    if [ -e "${legacy}" ] && { [ ! -s "${legacy}" ] || grep -qE "${generated_launcher}" "${legacy}"; }; then
      rm -f "${legacy}"
      echo "📝 git hooks: removed the self-referential ${hook_type}.legacy launcher in ${target}"
    fi

    if cmp -s "${launcher}" "${installed}" && [ -x "${installed}" ]; then
      continue
    fi

    # A hook this repository did not generate belongs to whoever wrote it. Keep it as the legacy
    # hook the launcher still calls, rather than deleting someone's work to open a shell.
    if [ -e "${installed}" ] && [ ! -e "${legacy}" ] && ! grep -qE "${generated_launcher}" "${installed}"; then
      mv "${installed}" "${legacy}"
      echo "📝 git hooks: kept the existing ${hook_type} hook as ${hook_type}.legacy in ${target}"
    fi

    # Rename, never write in place. `git commit` in another worktree can exec this exact path while
    # the copy is still being written, and half a launcher fails the commit for the wrong reason.
    staged="$(mktemp "${target}/.ferretry-${hook_type}.XXXXXX")"
    cat "${launcher}" >"${staged}"
    chmod 0755 "${staged}"
    mv -f "${staged}" "${installed}"
    echo "📝 git hooks: installed ${hook_type} into ${target}"
  done
done

# The worktree-scoped hooks path. This is the only setting that keeps a worktree still running the
# previous installation from deciding where THIS worktree looks for hooks, and it narrows nothing
# for anyone else: a worktree without one keeps reading the shared value and the shared launchers.
if [ -z "${isolation_blocked}" ] && [ "${worktree_hooks_path}" != "${worktree_hooks_dir}" ]; then
  if [ "$(git config --local --get extensions.worktreeConfig 2>/dev/null || true)" != "true" ]; then
    git config --local extensions.worktreeConfig true
  fi
  git config --worktree core.hooksPath "${worktree_hooks_dir}"
  echo "📝 git hooks: this worktree now resolves hooks from ${worktree_hooks_dir}"
fi
if [ -n "${isolation_blocked}" ]; then
  echo "📝 git hooks: ${isolation_blocked}, so this worktree shares ${hooks_dir} with every other" >&2
fi

# The shared value governs every worktree that has no worktree-scoped one, including the ones
# `packages/daemon` creates without ever opening a devshell. It is pinned to an absolute path rather
# than unset, because the previous installation writes a path relative to whichever worktree ran it
# — and in a linked worktree `.git/hooks` names a file rather than a directory, so those worktrees
# resolve no hooks at all. One value, written once, is also what makes this converge instead of
# alternating with an inherited global setting.
if [ "${local_hooks_path}" != "${hooks_dir}" ]; then
  git config --local core.hooksPath "${hooks_dir}"
  echo "📝 git hooks: pinned the shared core.hooksPath at ${hooks_dir}"
fi

echo "✅ git hooks: launchers installed; ${worktree_root} lints at its own revision"
