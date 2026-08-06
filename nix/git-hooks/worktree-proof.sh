#!/usr/bin/env bash
set -euo pipefail

# Proves that `nix/git-hooks/install.sh` makes commit linting work from a LINKED worktree, which is
# the only place this repository's agents ever commit from. It builds a throwaway repository with
# three linked worktrees under an isolated HOME — two the installer runs in and one it never touches
# — and drives it the way a devshell does: repeatedly, from both worktrees, concurrently, and with a
# worktree still running the previous installation working against it.
#
# It exists because every earlier attempt at this was verified by ancestry — the fix is on main,
# therefore the row is done — while the shared launcher on disk was rejecting valid commit subjects
# in every checkout of the repository. Ancestry cannot see that. A second worktree can.
#
#   usage: worktree-proof.sh <launcher-directory> <pre-commit-package>

launcher_dir="${1:-}"
pre_commit_package="${2:-}"
[ -z "${launcher_dir}" ] && echo "❌ git hooks proof: launcher directory argument missing" >&2 && exit 2
[ -z "${pre_commit_package}" ] && echo "❌ git hooks proof: pre-commit package argument missing" >&2 && exit 2

pre_commit_bin="${pre_commit_package}/bin/pre-commit"
[ ! -x "${pre_commit_bin}" ] && echo "❌ git hooks proof: ${pre_commit_bin} is not executable" >&2 && exit 2

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

install_script="${root_dir}/nix/git-hooks/install.sh"
commit_msg_gate="${root_dir}/scripts/validate/commit-msg.sh"
[ ! -x "${install_script}" ] && echo "❌ git hooks proof: ${install_script} is not executable" >&2 && exit 2
[ ! -x "${commit_msg_gate}" ] && echo "❌ git hooks proof: ${commit_msg_gate} is not executable" >&2 && exit 2

workspace="$(mktemp -d)"
trap 'chmod -R u+w "${workspace}" 2> /dev/null || true; rm -rf "${workspace}"' EXIT

# Nothing here may read or write the developer's real Git identity, hooks or pre-commit cache.
export HOME="${workspace}/home"
export PRE_COMMIT_HOME="${workspace}/pre-commit-cache"
export GIT_CONFIG_GLOBAL="${workspace}/gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
mkdir -p "${HOME}" "${PRE_COMMIT_HOME}"
: >"${GIT_CONFIG_GLOBAL}"
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

failures=0
report_failure() {
  echo "❌ ${1}" >&2
  failures=$((failures + 1))
}

# Every commit in this proof goes through the shared launcher, so its exit status and its output are
# the measurement. Fencing the status is the only way to assert on a refusal, and the timeout is the
# assertion that a damaged launcher pair terminates rather than calling itself without limit.
commit_output=""
commit_status=0
commit_created=""
commit_subject=""
# usage: attempt_commit <worktree> <subject> [NAME=VALUE ...]
# Every commit attempt goes through here, including the ones that need an environment override.
# A raw `git commit` beside it would leave these variables holding the PREVIOUS attempt's result,
# and the assertion after it would then be reading someone else's commit.
attempt_commit() {
  local before after
  commit_subject="${2}"
  before="$(git -C "${1}" rev-parse HEAD)"
  set +e
  commit_output="$(cd "${1}" && env "${@:3}" timeout 120 git commit --allow-empty -m "${2}" 2>&1)"
  commit_status=$?
  set -e
  # An exit status is a proxy; whether HEAD moved is the property that matters. A subject that
  # merely LOOKS invalid is a real trap — `test:` reads like a probe and is a conventional type,
  # so it passes, and a refusal that was never a refusal reads as a broken gate.
  after="$(git -C "${1}" rev-parse HEAD)"
  commit_created="$([ "${before}" != "${after}" ] && echo yes || true)"
}

inode_of() {
  # A rename gives a new inode and an in-place rewrite keeps the old one, which is how atomicity is
  # measured below. `find -printf` is GNU-only and `stat` spells this differently on each platform;
  # every path passed here is a fixed hook name, so `ls` has nothing awkward to handle.
  # shellcheck disable=SC2012
  ls -i "${1}" | awk '{ print $1 }'
}

install_from() {
  (cd "${1}" && "${install_script}" "${launcher_dir}" "${2}" "${pre_commit_package}") >/dev/null
}

echo "🔨 git hooks proof: building a scratch repository with linked worktrees"
repo="${workspace}/repo"
alpha="${workspace}/alpha"
beta="${workspace}/beta"
git init -q -b main "${repo}"
git -C "${repo}" config user.email proof@ferretry.invalid
git -C "${repo}" config user.name "Hooks Proof"
git -C "${repo}" commit -q --allow-empty -m "chore: root"
git -C "${repo}" worktree add -q "${alpha}" -b alpha
git -C "${repo}" worktree add -q "${beta}" -b beta

hooks_dir="$(git -C "${beta}" rev-parse --path-format=absolute --git-common-dir)"
hooks_dir="${hooks_dir%/}/hooks"
[ "${hooks_dir}" != "${repo}/.git/hooks" ] &&
  report_failure "a linked worktree resolved hooks to ${hooks_dir}, not the common directory"

# The config the launcher resolves per worktree. `alpha.yaml` is the repository's real
# conventional-commit gate; `beta.yaml` refuses everything with a marker, so a commit from beta
# proves WHICH worktree's config drove the hook rather than merely that a hook ran.
cat >"${workspace}/beta-gate.sh" <<'GATE'
#!/usr/bin/env bash
echo "beta-worktree-config-was-used" >&2
exit 1
GATE
chmod 0755 "${workspace}/beta-gate.sh"

cat >"${workspace}/alpha.yaml" <<CONFIG
repos:
  - repo: local
    hooks:
      - id: conventional-commit
        name: Conventional commit
        entry: bash ${commit_msg_gate}
        language: system
        stages: [commit-msg]
        pass_filenames: true
CONFIG
cat >"${workspace}/beta.yaml" <<CONFIG
repos:
  - repo: local
    hooks:
      - id: beta-marker
        name: Beta worktree marker
        entry: bash ${workspace}/beta-gate.sh
        language: system
        stages: [commit-msg]
        pass_filenames: true
CONFIG

echo "⚙️ git hooks proof: installing from both worktrees, twice each"
for _ in 1 2; do
  install_from "${alpha}" "${workspace}/alpha.yaml"
  install_from "${beta}" "${workspace}/alpha.yaml"
done

alpha_hooks="$(git -C "${alpha}" rev-parse --path-format=absolute --git-dir)/ferretry-hooks"
beta_hooks="$(git -C "${beta}" rev-parse --path-format=absolute --git-dir)/ferretry-hooks"

for target in "${hooks_dir}" "${alpha_hooks}" "${beta_hooks}"; do
  for launcher in "${launcher_dir}"/*; do
    hook_type="$(basename "${launcher}")"
    cmp -s "${launcher}" "${target}/${hook_type}" ||
      report_failure "${hook_type} in ${target} differs from the generated launcher"
    [ -x "${target}/${hook_type}" ] ||
      report_failure "${hook_type} in ${target} is not executable"
    [ -e "${target}/${hook_type}.legacy" ] &&
      report_failure "${hook_type}.legacy exists in ${target}: the installer engaged migration mode"
  done
done

echo "⚙️ git hooks proof: each worktree must resolve hooks from its own directory"
[ "$(git -C "${alpha}" config --worktree --get core.hooksPath)" != "${alpha_hooks}" ] &&
  report_failure "alpha does not resolve hooks from its own directory"
[ "$(git -C "${beta}" config --worktree --get core.hooksPath)" != "${beta_hooks}" ] &&
  report_failure "beta does not resolve hooks from its own directory"
[ "${alpha_hooks}" = "${beta_hooks}" ] &&
  report_failure "two worktrees were given the same private hooks directory"
# The shared value is the baseline for a worktree nobody has entered, and must stay absolute: a
# relative `.git/hooks` names a FILE in a linked worktree, so those worktrees resolve no hooks.
[ "$(git -C "${repo}" config --local --get core.hooksPath)" != "${hooks_dir}" ] &&
  report_failure "the shared core.hooksPath does not name the common hooks directory"

echo "🧪 git hooks proof: a worktree that never entered a devshell must still be linted"
never_entered="${workspace}/gamma"
git -C "${repo}" worktree add -q "${never_entered}" -b gamma
ln -s "${workspace}/alpha.yaml" "${never_entered}/.pre-commit-config.yaml"
attempt_commit "${never_entered}" "fix(worktree): a valid conventional subject"
[ "${commit_status}" -ne 0 ] &&
  report_failure "a worktree created without a devshell entry could not commit (exit ${commit_status}): ${commit_output}"
[ -z "${commit_created}" ] && report_failure "an accepted subject created no commit: ${commit_subject}"
attempt_commit "${never_entered}" "not a conventional subject"
[ "${commit_status}" -eq 0 ] &&
  report_failure "a worktree created without a devshell entry was not linted at all"
[ -n "${commit_created}" ] && report_failure "a refused subject still created a commit: ${commit_subject}"

echo "⚙️ git hooks proof: repeated entry must not rewrite a launcher"
settled_inode="$(inode_of "${hooks_dir}/commit-msg")"
install_from "${alpha}" "${workspace}/alpha.yaml"
[ "$(inode_of "${hooks_dir}/commit-msg")" != "${settled_inode}" ] &&
  report_failure "a settled worktree rewrote commit-msg; the install is not idempotent"

echo "⚙️ git hooks proof: sixteen concurrent entries across both worktrees"
# Damage every launcher first, so all sixteen entries want to write the shared directory at once.
# Sixteen no-ops would prove nothing about serialisation.
for target in "${hooks_dir}" "${alpha_hooks}" "${beta_hooks}"; do
  printf 'not a launcher\n' >"${target}/pre-commit"
  printf 'not a launcher\n' >"${target}/commit-msg"
done
for _ in 1 2 3 4 5 6 7 8; do
  install_from "${alpha}" "${workspace}/alpha.yaml" 2>/dev/null &
  install_from "${beta}" "${workspace}/alpha.yaml" 2>/dev/null &
done
wait

for target in "${hooks_dir}" "${alpha_hooks}" "${beta_hooks}"; do
  for launcher in "${launcher_dir}"/*; do
    hook_type="$(basename "${launcher}")"
    cmp -s "${launcher}" "${target}/${hook_type}" ||
      report_failure "${hook_type} in ${target} was corrupted by concurrent installs"
    rm -f "${target}/${hook_type}.legacy"
  done
  [ -n "$(find "${target}" -maxdepth 1 -name '.ferretry-*' 2>/dev/null)" ] &&
    report_failure "concurrent installs left a staged launcher behind in ${target}"
done
[ -d "${repo}/.git/ferretry-git-hooks.lock" ] &&
  report_failure "concurrent installs left the install lock held"

echo "🧪 git hooks proof: a valid subject must commit from the SECOND worktree"
attempt_commit "${beta}" "fix(worktree): a valid conventional subject"
[ "${commit_status}" -ne 0 ] &&
  report_failure "a valid conventional subject was refused from a linked worktree (exit ${commit_status}): ${commit_output}"
[ -z "${commit_created}" ] && report_failure "an accepted subject created no commit: ${commit_subject}"

echo "🧪 git hooks proof: an invalid subject must be refused from the SECOND worktree"
attempt_commit "${beta}" "not a conventional subject"
[ "${commit_status}" -eq 0 ] &&
  report_failure "an invalid subject committed from a linked worktree"
[ -n "${commit_created}" ] && report_failure "a refused subject still created a commit: ${commit_subject}"
case "${commit_output}" in
*"not a conventional commit"*) ;;
*) report_failure "the refusal did not carry the conventional-commit diagnostic: ${commit_output}" ;;
esac

echo "🧪 git hooks proof: each worktree lints at its own revision of the config"
install_from "${beta}" "${workspace}/beta.yaml"
attempt_commit "${beta}" "fix(worktree): a valid conventional subject"
case "${commit_output}" in
*beta-worktree-config-was-used*) ;;
*) report_failure "beta did not lint with its own config; the shared launcher chose one for it: ${commit_output}" ;;
esac
attempt_commit "${alpha}" "fix(worktree): a valid conventional subject"
[ "${commit_status}" -ne 0 ] &&
  report_failure "alpha stopped committing once beta installed a different config (exit ${commit_status}): ${commit_output}"
[ -z "${commit_created}" ] && report_failure "an accepted subject created no commit: ${commit_subject}"
install_from "${beta}" "${workspace}/alpha.yaml"

echo "🧪 git hooks proof: a commit made outside a devshell falls back to the pinned pre-commit"
mkdir -p "${workspace}/bin"
printf '#!/usr/bin/env bash\necho "a pre-commit outside the store must not be trusted" >&2\nexit 1\n' \
  >"${workspace}/bin/pre-commit"
chmod 0755 "${workspace}/bin/pre-commit"
attempt_commit "${beta}" "fix(worktree): committed without a devshell pre-commit" \
  "PATH=${workspace}/bin:${PATH}"
[ "${commit_status}" -ne 0 ] &&
  report_failure "the pinned pre-commit fallback did not carry a commit made outside a devshell (exit ${commit_status}): ${commit_output}"
[ -z "${commit_created}" ] && report_failure "an accepted subject created no commit: ${commit_subject}"

echo "🧪 git hooks proof: a commit under another repository's launcher must still be linted"
# The launcher's recursion guard is exported, so it reaches every nested process — a `git commit`
# in a scratch repository run from inside this repository's own hook, which is exactly how this
# gate runs during a commit. A guard that is a bare flag rather than a launcher's own identity
# silences all of them, and the hook becomes a no-op that passes everything.
attempt_commit "${beta}" "not a conventional subject under a foreign guard" \
  "FERRETRY_GIT_HOOK=/somewhere/else/commit-msg"
[ "${commit_status}" -eq 0 ] &&
  report_failure "an inherited FERRETRY_GIT_HOOK turned the commit-msg hook into a no-op"
[ -n "${commit_created}" ] && report_failure "a refused subject still created a commit: ${commit_subject}"

echo "🧪 git hooks proof: a migration-mode launcher pair must be repaired, not inherited"
# Damage the directory beta actually reads, so the recovery is measured by a commit and not only by
# a file comparison.
cp "${beta_hooks}/commit-msg" "${beta_hooks}/commit-msg.legacy"
cat >"${beta_hooks}/commit-msg" <<'MIGRATED'
#!/usr/bin/env bash
# File generated by pre-commit: https://pre-commit.com
echo "bug: pre-commit's script is installed in migration mode" >&2
exit 1
MIGRATED
chmod 0755 "${beta_hooks}/commit-msg"
attempt_commit "${beta}" "fix(worktree): refused while migration mode is in place"
[ "${commit_status}" -eq 0 ] &&
  report_failure "a migration-mode launcher pair let a commit through"
[ -n "${commit_created}" ] && report_failure "a refused subject still created a commit: ${commit_subject}"
damaged_inode="$(inode_of "${beta_hooks}/commit-msg")"
install_from "${beta}" "${workspace}/alpha.yaml"
[ -e "${beta_hooks}/commit-msg.legacy" ] &&
  report_failure "the self-referential commit-msg.legacy survived a reinstall"
cmp -s "${launcher_dir}/commit-msg" "${beta_hooks}/commit-msg" ||
  report_failure "a migration-mode commit-msg was not replaced by the generated launcher"
# A rename gives a new inode; an in-place rewrite keeps the old one, and a commit racing that
# rewrite execs a truncated launcher.
[ "$(inode_of "${beta_hooks}/commit-msg")" = "${damaged_inode}" ] &&
  report_failure "the launcher was written in place rather than renamed into position"
attempt_commit "${beta}" "fix(worktree): commits work again after repair"
[ "${commit_status}" -ne 0 ] &&
  report_failure "commits stayed broken after the repair (exit ${commit_status}): ${commit_output}"
[ -z "${commit_created}" ] && report_failure "an accepted subject created no commit: ${commit_subject}"

# A hook this repository did not write must survive AND still run. Asserting only that the `.legacy`
# file exists proves preservation and nothing else — a kept hook nobody invokes is exactly the
# regression `--hook-dir` exists to prevent, and it would look identical on disk. So the kept hook
# writes a marker and a real commit has to produce it. Both install targets are covered, because
# they are read by different worktrees: the private one by the worktree that owns it, the shared one
# by every worktree that never entered a devshell.
echo "🧪 git hooks proof: a hook this repository did not write is kept AND still runs"
cat >"${beta_hooks}/pre-commit" <<HOOK
#!/usr/bin/env bash
touch ${workspace}/kept-private-hook-ran
exit 0
HOOK
chmod 0755 "${beta_hooks}/pre-commit"
install_from "${beta}" "${workspace}/alpha.yaml"
[ ! -e "${beta_hooks}/pre-commit.legacy" ] &&
  report_failure "an unrecognised private pre-commit hook was deleted instead of kept as pre-commit.legacy"
rm -f "${workspace}/kept-private-hook-ran"
attempt_commit "${beta}" "fix(worktree): a commit that must also run the kept private hook"
[ "${commit_status}" -ne 0 ] &&
  report_failure "the kept private hook broke the commit (exit ${commit_status}): ${commit_output}"
[ -z "${commit_created}" ] && report_failure "an accepted subject created no commit: ${commit_subject}"
[ ! -e "${workspace}/kept-private-hook-ran" ] &&
  report_failure "the kept private pre-commit hook survived on disk but was never invoked"
rm -f "${beta_hooks}/pre-commit.legacy"

cat >"${hooks_dir}/pre-commit" <<HOOK
#!/usr/bin/env bash
touch ${workspace}/kept-shared-hook-ran
exit 0
HOOK
chmod 0755 "${hooks_dir}/pre-commit"
install_from "${alpha}" "${workspace}/alpha.yaml"
[ ! -e "${hooks_dir}/pre-commit.legacy" ] &&
  report_failure "an unrecognised shared pre-commit hook was deleted instead of kept as pre-commit.legacy"
rm -f "${workspace}/kept-shared-hook-ran"
attempt_commit "${never_entered}" "fix(worktree): a commit that must also run the kept shared hook"
[ "${commit_status}" -ne 0 ] &&
  report_failure "the kept shared hook broke the commit (exit ${commit_status}): ${commit_output}"
[ -z "${commit_created}" ] && report_failure "an accepted subject created no commit: ${commit_subject}"
[ ! -e "${workspace}/kept-shared-hook-ran" ] &&
  report_failure "the kept shared pre-commit hook survived on disk but was never invoked"
rm -f "${hooks_dir}/pre-commit.legacy"

echo "🧪 git hooks proof: a relative shared core.hooksPath must be repaired"
# `.git/hooks` is what the previous installation writes from the main checkout, and in a linked
# worktree `.git` is a FILE — so every worktree reading the shared value resolves no hooks at all.
git -C "${repo}" config --local core.hooksPath .git/hooks
install_from "${beta}" "${workspace}/alpha.yaml"
[ "$(git -C "${repo}" config --local --get core.hooksPath)" != "${hooks_dir}" ] &&
  report_failure "the shared core.hooksPath stayed relative, which no linked worktree can resolve"
attempt_commit "${never_entered}" "fix(worktree): a never-entered worktree survives a relative hooks path"
[ "${commit_status}" -ne 0 ] &&
  report_failure "a relative shared core.hooksPath left a never-entered worktree broken (exit ${commit_status}): ${commit_output}"
[ -z "${commit_created}" ] && report_failure "an accepted subject created no commit: ${commit_subject}"
attempt_commit "${beta}" "fix(worktree): commits survive a stale core.hooksPath"
[ "${commit_status}" -ne 0 ] &&
  report_failure "a stale core.hooksPath left commits broken (exit ${commit_status}): ${commit_output}"
[ -z "${commit_created}" ] && report_failure "an accepted subject created no commit: ${commit_subject}"

# The rollout case, and the reason per-worktree isolation exists at all. Worktrees cut before this
# change still run the previous shellHook, which calls `pre-commit install` without `-f` on every
# entry and demotes whatever occupies the shared path — a launcher installed seconds earlier
# included. On the real repository that was measured at twenty takeovers a minute, and in that state
# EVERY commit fails, valid subject or not. An updated worktree must be unaffected while it happens,
# not merely able to recover afterwards, or this fix would depend on every stale branch rebasing.
echo "🧪 git hooks proof: a worktree still running the previous installation must not break this one"
cp "${workspace}/alpha.yaml" "${repo}/.git/ferretry-pre-commit-config.yaml"
# Replayed from the worktree the installer has never run in, because that is what a stale checkout
# is: no worktree-scoped hooks path, and `pre-commit install` therefore writing the shared directory
# rather than refusing. Replaying it from an updated worktree would prove nothing — pre-commit
# refuses outright once a hooks path is set, which is itself part of why isolation holds.
(
  cd "${never_entered}"
  git config --local --unset-all core.hooksPath || true
  for hook_type in pre-commit commit-msg; do
    "${pre_commit_bin}" install -c "${repo}/.git/ferretry-pre-commit-config.yaml" -t "${hook_type}"
    # Deliberately unexpanded: this is the literal text the previous installation sed-patched into
    # the launcher, and expanding it here would replay a different shellHook than the one under test.
    # shellcheck disable=SC2016
    config_from_hook_dir='$(cd "$(dirname "$0")/.."; pwd)/ferretry-pre-commit-config.yaml'
    sed -i "s|^ARGS=(hook-impl --config=.* --hook-type=${hook_type})$|ARGS=(hook-impl --config=\"${config_from_hook_dir}\" --hook-type=${hook_type})|" \
      "${hooks_dir}/${hook_type}"
  done
  git config --local core.hooksPath "${repo}/.git/hooks"
) >"${workspace}/legacy-install.log" 2>&1 || true
grep -q 'migration mode' "${workspace}/legacy-install.log" ||
  report_failure "the replayed previous installation did not engage migration mode; it proves nothing"

attempt_commit "${beta}" "fix(worktree): valid while a stale worktree owns the shared hooks"
[ "${commit_status}" -eq 124 ] &&
  report_failure "a launcher demoted to .legacy called itself without limit; the commit had to be killed"
[ "${commit_status}" -ne 0 ] &&
  report_failure "a stale worktree's install broke an updated worktree's commit (exit ${commit_status}): ${commit_output}"
[ -z "${commit_created}" ] && report_failure "an accepted subject created no commit: ${commit_subject}"
attempt_commit "${beta}" "not a conventional subject while a stale worktree owns the shared hooks"
[ "${commit_status}" -eq 0 ] &&
  report_failure "an invalid subject committed while a stale worktree owned the shared hooks"
[ -n "${commit_created}" ] && report_failure "a refused subject still created a commit: ${commit_subject}"

# The shared baseline is still reclaimed on the next entry, which is what restores the worktrees
# that read it — the never-entered ones a stale checkout can still take down with it.
install_from "${beta}" "${workspace}/alpha.yaml"
attempt_commit "${never_entered}" "fix(worktree): a never-entered worktree recovers with the baseline"
[ "${commit_status}" -ne 0 ] &&
  report_failure "the shared baseline did not restore a never-entered worktree (exit ${commit_status}): ${commit_output}"
[ -z "${commit_created}" ] && report_failure "an accepted subject created no commit: ${commit_subject}"
cmp -s "${launcher_dir}/commit-msg" "${hooks_dir}/commit-msg" ||
  report_failure "an updated worktree did not reclaim the shared commit-msg from the previous installation"
[ -e "${hooks_dir}/commit-msg.legacy" ] &&
  report_failure "the previous installation's commit-msg.legacy survived the next updated entry"

[ "${failures}" -ne 0 ] && echo "❌ git hooks proof: ${failures} assertion(s) failed" >&2 && exit 1

echo "✅ git hooks proof: valid and invalid subjects behave correctly from a linked worktree, across repeated, concurrent, never-entered and stale-worktree installs"
