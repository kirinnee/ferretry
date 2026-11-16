#!/usr/bin/env bash
set -euo pipefail

# Push the built Linux packages (deb/rpm) to the Gemfury account behind the apt/yum channel
# (see INSTALLATION.md). Idempotent: a 409 (version already exists) is a warning, not a failure.
#
# Usage: scripts/release/fury.sh [dist-dir]   (default: dist)
#
# The packages are pushed IN PARALLEL: Gemfury indexes an rpm for ~85 s and a deb for ~11 s, and pushed one
# after another that was 193 s for four packages (2026-11-16). Every push runs to its end, every exit code
# is collected, and the script fails if any push failed. cd.yaml runs it as its own `fury` job on the
# packages of the tag's GitHub release, after `goreleaser`, so a slow or failed push blocks neither the
# release nor its signature.
[ -z "${FURY_PUSH_TOKEN:-}" ] && echo "❌ 'FURY_PUSH_TOKEN' env var not set" >&2 && exit 1

endpoint="push.fury.io/kirinnee97"
dist="${1:-dist}"

# Keep the token out of argv and process listings. curl reads the equivalent
# Basic-auth setting from a mode-0600 config that is removed on every exit.
credential_config="$(mktemp)"
results_dir="$(mktemp -d)"
chmod 600 "${credential_config}"
trap 'rm -rf -- "${credential_config}" "${results_dir}"' EXIT
{
  printf 'user = "'
  printf '%s' "${FURY_PUSH_TOKEN}" | sed 's/\\/\\\\/g; s/"/\\"/g'
  printf ':"\n'
} >"${credential_config}"

shopt -s nullglob
packages=("${dist}"/*.deb "${dist}"/*.rpm)
[ "${#packages[@]}" -eq 0 ] && echo "❌ no deb/rpm packages found in ${dist}/" >&2 && exit 1

# Pushes one package and reports in ${results_dir}/<name>.{status,body}; its exit code is the verdict.
push_one() {
  local pkg="$1" name status body
  name="$(basename "${pkg}")"
  body="${results_dir}/${name}.body"
  echo "📤 pushing ${pkg} -> ${endpoint}"
  status="$(
    curl --config "${credential_config}" -sS --connect-timeout 30 --max-time 600 -o "${body}" -w '%{http_code}' -F package=@"${pkg}" "https://${endpoint}/"
  )" || {
    echo "❌ Gemfury push failed for ${pkg} (curl could not complete the request)" >&2
    return 1
  }
  case "${status}" in
  2*) echo "✅ ${pkg} pushed" ;;
  409) echo "⚠️ ${pkg} already exists on Gemfury — skipping" ;;
  *)
    echo "❌ Gemfury push failed for ${pkg} (HTTP ${status})" >&2
    cat "${body}" >&2
    return 1
    ;;
  esac
}

pids=()
for pkg in "${packages[@]}"; do
  push_one "${pkg}" &
  pids+=("$!")
done

failed=0
for pid in "${pids[@]}"; do
  wait "${pid}" || failed=$((failed + 1))
done

[ "${failed}" -gt 0 ] && echo "❌ ${failed} of ${#packages[@]} Gemfury push(es) failed" >&2 && exit 1

echo "✅ pushed ${#packages[@]} package(s) to Gemfury"
