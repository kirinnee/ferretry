#!/usr/bin/env bash
set -euo pipefail

# Downloads a dev shell's closure before the job's real step enters it, retrying a failed download.
#
# WHY THIS EXISTS. cache.nixos.org sometimes breaks a download mid-file: Nix resumes it from the byte it
# had, the CDN answers the resumed range with HTTP 416, and Nix gives up with "path … is required, but
# there is no substituter that can build it". That failure is the network's, not the change's, yet it
# failed whole CI jobs (Containment (macOS) on `main`, Sandbox Shell (Safari)) and skipped releases. A
# fresh attempt downloads the file from its first byte, so it succeeds where the resume could not.
#
# WHY A SEPARATE STEP. The job's real step is `nix develop <shell> -c <script>`; retrying THAT would rerun
# the tests. `nix print-dev-env` realises exactly what `nix develop` needs and runs nothing, so only the
# download is retried. Every path that arrived stays in the store, so a retry fetches only what is left.
#
# BOUNDED AND LOUD. At most `FY_NIX_REALISE_ATTEMPTS` (3) attempts, each failure a `::warning::`, and the
# last one fails the step with Nix's own error above it. A real evaluation or build failure fails every
# attempt the same way, so it still reaches the PR, a minute later.
#
# Local reproduction: `./scripts/ci/nix-realise.sh .#ci`.

shell="${1:-}"
attempts="${FY_NIX_REALISE_ATTEMPTS:-3}"

[ -z "${shell}" ] && echo "❌ usage: nix-realise.sh <flake dev shell, e.g. .#ci>" >&2 && exit 1

attempt=1
# The printed environment is kept for scripts/ci/in-devshell.sh, which sources it instead of paying for
# `nix develop` again in every later step of the job.
env_file="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fy-devshell-${shell//[^A-Za-z0-9]/_}.sh"
until nix print-dev-env "${shell}" >"${env_file}"; do
  [ "${attempt}" -ge "${attempts}" ] && echo "❌ could not realise ${shell} in ${attempts} attempts" >&2 && exit 1
  echo "::warning::realising ${shell} failed (attempt ${attempt} of ${attempts}); retrying in $((attempt * 20))s — a network failure, if Nix's error above names a download"
  sleep "$((attempt * 20))"
  attempt="$((attempt + 1))"
done
if [[ -n ${GITHUB_ENV:-} ]]; then
  echo "FY_DEVSHELL_ENV=${env_file}" >>"${GITHUB_ENV}"
  echo "FY_DEVSHELL=${shell}" >>"${GITHUB_ENV}"
fi
echo "✅ ${shell} realised (attempt ${attempt} of ${attempts})"
