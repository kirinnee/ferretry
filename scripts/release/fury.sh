#!/usr/bin/env bash
set -euo pipefail

# Push the built Linux packages (deb/rpm) to the Gemfury account behind the apt/yum channel
# (see INSTALLATION.md). Idempotent: a 409 (version already exists) is a warning, not a failure.
[ -z "${FURY_PUSH_TOKEN:-}" ] && echo "❌ 'FURY_PUSH_TOKEN' env var not set" >&2 && exit 1

endpoint="push.fury.io/kirinnee97"

# Keep the token out of argv and process listings. curl reads the equivalent
# Basic-auth setting from a mode-0600 config that is removed on every exit.
credential_config="$(mktemp)"
response_body="$(mktemp)"
chmod 600 "${credential_config}"
trap 'rm -f -- "${credential_config}" "${response_body}"' EXIT
{
  printf 'user = "'
  printf '%s' "${FURY_PUSH_TOKEN}" | sed 's/\\/\\\\/g; s/"/\\"/g'
  printf ':"\n'
} >"${credential_config}"

shopt -s nullglob
packages=(dist/*.deb dist/*.rpm)
[ "${#packages[@]}" -eq 0 ] && echo "❌ no deb/rpm packages found in dist/" >&2 && exit 1

for pkg in "${packages[@]}"; do
  echo "📤 pushing ${pkg} -> ${endpoint}"
  status="$(
    curl --config "${credential_config}" -sS --connect-timeout 30 --max-time 600 -o "${response_body}" -w '%{http_code}' -F package=@"${pkg}" "https://${endpoint}/"
  )"
  case "${status}" in
  2*) ;;
  409) echo "⚠️ ${pkg} already exists on Gemfury — skipping" ;;
  *)
    echo "❌ Gemfury push failed for ${pkg} (HTTP ${status})" >&2
    cat "${response_body}" >&2
    exit 1
    ;;
  esac
done

echo "✅ pushed ${#packages[@]} package(s) to Gemfury"
