#!/usr/bin/env bash
set -euo pipefail

# THE macOS RUNNER POLICY (docs/standards/ci-cd, "macOS runner shortage").
#
# GitHub's macOS pool is small and shared, and a job it never gives a runner is cancelled with no step
# run. So the one macOS job left, the darwin-arm64 smoke (`smoke-darwin.yaml`, called by CI and CD), is
# ADVISORY on a pull request (a missing runner is a warning, a failed smoke is still red), REQUIRED and
# retried on `main` and a release tag, and only the free standard `macos-15` runner is ever asked for.
# This holds the workflows to that policy and runs the verdict on canned results.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

ci_workflow=".github/workflows/ci.yaml"

fail() {
  echo "❌ $*" >&2
  exit 1
}

smoke_workflow=".github/workflows/smoke-darwin.yaml"
cd_workflow=".github/workflows/cd.yaml"
[ -f "${smoke_workflow}" ] || fail "${smoke_workflow} is missing"
[ -f "${cd_workflow}" ] || fail "${cd_workflow} is missing"

workflow_job_block() {
  awk -v id="$2" '
    $0 == "  " id ":" { in_job = 1; print; next }
    in_job && /^  [A-Za-z0-9_-]+:$/ { exit }
    in_job { print }
  ' "$1"
}
workflow_job_has() {
  local file="$1" id="$2" pattern="$3" what="$4" block
  block="$(workflow_job_block "${file}" "${id}")"
  [ -n "${block}" ] || fail "${file} has no job '${id}'"
  rg -q -- "${pattern}" <<<"${block}" || fail "${file}: job '${id}' ${what}"
}

# No new spend: the only macOS runner is the free standard `macos-15` of a public repository — never a
# larger, a Namespace or a self-hosted one — and only the files that own a macOS job may use it.
mapfile -t mac_runner_files < <(rg -l -i 'macos|mac-os|darwin.*runs-on' .github/workflows | sort)
for file in "${mac_runner_files[@]}"; do
  case "${file}" in
  .github/workflows/smoke-darwin.yaml | .github/workflows/ci.yaml | .github/workflows/cd.yaml) ;;
  *) fail "${file}: a workflow outside the macOS policy mentions macOS; route it through smoke-darwin.yaml or declare it here" ;;
  esac
done
unexpected_macos="$(rg -N --no-filename -v '^[[:space:]]*#' .github/workflows | rg -o 'macos-[0-9]+[A-Za-z0-9-]*' | rg -v '^macos-15$' || true)"
[ -z "${unexpected_macos}" ] || fail "a macOS runner other than the free standard macos-15 is named: ${unexpected_macos}"
macos_jobs="$(rg -c '^    runs-on: macos-15$' .github/workflows | sort | tr '\n' ' ')"
[ "${macos_jobs}" = '.github/workflows/smoke-darwin.yaml:3 ' ] ||
  fail "the macOS job inventory changed (smoke-darwin.yaml: 3 attempts, nothing else); update this validator and docs/standards/ci-cd together: ${macos_jobs}"
if rg -n -i 'runs-on:.*(macos-[0-9]+-(large|xlarge|intel)|nscloud-mac|macos-latest-(large|xlarge))|runs-on:.*self-hosted' .github/workflows >/dev/null; then
  fail 'a workflow asks for a paid or self-hosted macOS runner; the macOS pool is the free standard macos-15 only (docs/standards/ci-cd, "macOS runner shortage")'
fi

# The reusable smoke: three attempts, each a bounded `macos-15` job that records that it started, a
# backoff between them that runs only on a pull-request-free, never-started attempt (read from `started`,
# never from `result`: GitHub gives a job it never ran `abandoned`), and one verdict.
for attempt in attempt-1 attempt-2 attempt-3; do
  workflow_job_has "${smoke_workflow}" "${attempt}" '^    runs-on: macos-15$' 'must run on the free macos-15 runner'
  workflow_job_has "${smoke_workflow}" "${attempt}" '^    timeout-minutes: [0-9]+$' 'must state timeout-minutes'
  workflow_job_has "${smoke_workflow}" "${attempt}" 'started=true' 'must record that it started, so the verdict can tell "no runner" from "failed"'
done
for backoff in backoff-1 backoff-2; do
  workflow_job_has "${smoke_workflow}" "${backoff}" "result != 'success' && needs[.]attempt-[12][.]result != 'skipped' && needs[.]attempt-[12][.]outputs[.]started != 'true'" 'must re-queue only an attempt that never started, whatever its result says'
  if workflow_job_block "${smoke_workflow}" "${backoff}" | rg -q "result == 'cancelled'"; then
    fail "${smoke_workflow}: job '${backoff}' must not key on result == 'cancelled': GitHub reports a job it never gave a runner as 'abandoned'"
  fi
done
workflow_job_has "${smoke_workflow}" backoff-1 '!inputs[.]advisory' 'must not retry on an advisory (pull request) run'
workflow_job_has "${smoke_workflow}" verdict 'scripts/ci/macos-smoke-verdict[.]sh' 'must judge through scripts/ci/macos-smoke-verdict.sh'
workflow_job_has "${smoke_workflow}" verdict 'ADVISORY: [$][{][{] inputs[.]advisory [}][}]' 'must pass inputs.advisory to the verdict'
rg -q '^  workflow_call:' "${smoke_workflow}" || fail "${smoke_workflow}: must be a workflow_call"
[ "$(rg -c 'runs-on: macos-' "${smoke_workflow}")" = 3 ] || fail "${smoke_workflow}: exactly three attempts may use a macOS runner"

# ci.yaml: Linux smoke stays a required matrix with no macOS leg; Darwin smoke is advisory only on a pull request.
if workflow_job_block "${ci_workflow}" smoke | rg -v "^[[:space:]]*#" | rg -qi "darwin|macos"; then
  fail "${ci_workflow}: the Linux smoke matrix must not carry a macOS leg; Smoke darwin-arm64 is the smoke-darwin job"
fi
workflow_job_has "${ci_workflow}" smoke-darwin '^    uses: [.]/[.]github/workflows/smoke-darwin[.]yaml$' 'must call smoke-darwin.yaml'
workflow_job_has "${ci_workflow}" smoke-darwin "^      advisory: [\$][{][{] github[.]event_name == 'pull_request' [}][}]\$" 'must be advisory on a pull request and only there'
workflow_job_has "${ci_workflow}" smoke-darwin '^    needs: compile$' 'must need compile'
# Its one condition combines the full-set trigger with the owner's skip switch.
[ "$(workflow_job_block "${ci_workflow}" smoke-darwin | rg -c '^    if:')" = 1 ] || fail "${ci_workflow}: Smoke darwin-arm64 must carry exactly one if:, the full-set condition and MACOS_SMOKE switch"
workflow_job_has "${ci_workflow}" smoke-darwin "vars[.]MACOS_SMOKE != 'skip'" "must run in the full set unless vars.MACOS_SMOKE is 'skip'"
workflow_job_has "${ci_workflow}" compile "if: [\$][{][{] vars[.]MACOS_SMOKE == 'skip' [}][}]" 'must say, in a job that runs, that the smoke was skipped by the switch'
workflow_job_has "${ci_workflow}" compile 'scripts/ci/macos-smoke-skipped[.]sh' 'must say, in a job that runs, that the smoke was skipped by the switch'

# cd.yaml: a release tag requires the darwin smoke, with its retries, before anything is published.
workflow_job_has "${cd_workflow}" smoke-darwin '^    uses: [.]/[.]github/workflows/smoke-darwin[.]yaml$' 'must call smoke-darwin.yaml'
workflow_job_has "${cd_workflow}" smoke-darwin '^      advisory: false$' 'must be required (advisory: false) on a release tag'
workflow_job_has "${cd_workflow}" smoke-darwin "^    if: [\$][{][{] vars[.]MACOS_SMOKE != 'skip' [}][}]\$" "must run unless vars.MACOS_SMOKE is 'skip'"
workflow_job_has "${cd_workflow}" goreleaser '^    needs: \[compile, smoke-darwin\]$' 'must wait for the compile and the darwin smoke'
# A skipped smoke publishes only through the owner's switch, and never past a failed compile or smoke.
workflow_job_has "${cd_workflow}" goreleaser "^    if: [\$][{][{] !cancelled[(][)] && needs[.]compile[.]result == 'success' && [(]needs[.]smoke-darwin[.]result == 'success' [|][|] [(]vars[.]MACOS_SMOKE == 'skip' && needs[.]smoke-darwin[.]result == 'skipped'[)][)] [}][}]\$" 'must publish only after a green smoke, or a smoke skipped by vars.MACOS_SMOKE=skip, and a green compile'
workflow_job_has "${cd_workflow}" goreleaser 'scripts/ci/macos-smoke-skipped[.]sh' 'must say, in a job that runs, that the smoke was skipped by the switch'
workflow_job_has "${cd_workflow}" sign '^    needs: goreleaser$' 'must wait for goreleaser, so nothing is signed past a skipped publish'
# ... and must run when goreleaser published past a smoke skipped by the switch: an implicit success() would
# skip it through the skipped ancestor, leaving the release unsigned.
workflow_job_has "${cd_workflow}" sign "^    if: [\$][{][{] !cancelled[(][)] && needs[.]goreleaser[.]result == 'success' [}][}]\$" 'must run after a goreleaser that published past a smoke skipped by vars.MACOS_SMOKE, and only then'

# The verdict, run on canned results, decides as the doctrine says.
verdict() {
  NEEDS="$1" ADVISORY="$2" GITHUB_STEP_SUMMARY=/dev/null scripts/ci/macos-smoke-verdict.sh >/dev/null 2>&1
}
unstarted='{"attempt-1":{"result":"cancelled","outputs":{}},"attempt-2":{"result":"skipped","outputs":{}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${unstarted}" true || fail "a pull request whose macOS smoke never got a runner must not fail"
verdict "${unstarted}" false && fail "main or a release tag whose macOS smoke never got a runner must fail after its retries"
ran_and_failed='{"attempt-1":{"result":"failure","outputs":{"started":"true"}},"attempt-2":{"result":"skipped","outputs":{}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${ran_and_failed}" true && fail "a macOS smoke that ran and failed must fail, even on a pull request"
# GitHub hands `needs` the word "abandoned" for a job it never gave a runner (run 41856821125), not "cancelled".
abandoned='{"attempt-1":{"result":"abandoned","outputs":{}},"attempt-2":{"result":"skipped","outputs":{}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${abandoned}" true || fail "a pull request whose macOS smoke was abandoned for want of a runner must not fail"
verdict "${abandoned}" false && fail "main or a release tag whose macOS smoke was abandoned for want of a runner must fail after its retries"
failed_unstarted='{"attempt-1":{"result":"failure","outputs":{}},"attempt-2":{"result":"skipped","outputs":{}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${failed_unstarted}" true || fail "a smoke attempt that failed before its first step ran is a runner problem, not a failed smoke"
cut_short='{"attempt-1":{"result":"cancelled","outputs":{"started":"true"}},"attempt-2":{"result":"skipped","outputs":{}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${cut_short}" true || fail "a pull request whose macOS smoke was cut off after it started must not fail"
verdict "${cut_short}" false && fail "main or a release tag whose macOS smoke was cut off after it started must fail"
nothing_ran='{"attempt-1":{"result":"skipped","outputs":{}},"attempt-2":{"result":"skipped","outputs":{}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${nothing_ran}" true && fail "a verdict with no attempt at all must fail, even on a pull request"
failed_after_retry='{"attempt-1":{"result":"abandoned","outputs":{}},"attempt-2":{"result":"failure","outputs":{"started":"true"}},"attempt-3":{"result":"skipped","outputs":{}}}'
verdict "${failed_after_retry}" false && fail "a smoke that ran and failed on a retry must fail"
passed_late='{"attempt-1":{"result":"cancelled","outputs":{}},"attempt-2":{"result":"cancelled","outputs":{}},"attempt-3":{"result":"success","outputs":{"started":"true"}}}'
verdict "${passed_late}" false || fail "a macOS smoke that passes on a retry must pass"

echo "✅ macOS runner policy holds: the darwin smoke is advisory on a pull request, required (and retried) on main and a release tag, and only macos-15 is asked for"
