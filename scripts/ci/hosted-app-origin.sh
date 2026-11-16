#!/usr/bin/env bash
set -euo pipefail
#
# The ONE build-time switch for WHICH hosted app a build belongs to: its origin, its release public key, and the
# defines that carry both into a daemon. Every consumer asks this script; none reads FY_HOSTED_APP_ORIGIN itself.
#
#   hosted-app-origin.sh                 the origin this build links to (stdout)
#   hosted-app-origin.sh --default       the production origin, read from the source module
#   hosted-app-origin.sh --key-file      the release public key file this build signs and verifies against
#   hosted-app-origin.sh --next-key-file the next-key file that goes with it
#   hosted-app-origin.sh --defines       the daemon's `KEY=VALUE` build defines, one per line; NOTHING for the default
#
# THE SOURCE. The production origin is the one `export const DEFAULT_HOSTED_APP_ORIGIN` in
# `packages/core/kernel/contract/hosted-app.ts`. `scripts/validate/hosted-app-origin.sh` fails when a second literal
# appears anywhere else, the way `relay-config.sh` does for the relay directory.
#
# THE SWITCH. `FY_HOSTED_APP_ORIGIN` names another hosted app (the 5.0 preview sets https://ferretry-v5.pages.dev).
# It must be a plain https origin (no path, query, fragment or credentials), because it becomes a link a browser
# launcher opens. Unset or blank is the production app, and then the key is `packages/app/release-signing-key.pub`
# and no define is passed, so an ordinary build is byte-for-byte what it was. A named app signs with its OWN key,
# `packages/app/release-signing-key.preview.pub`, committed on the branch that deploys it and nowhere else.
#
# DEPENDENCY-FREE (bash, sed, awk, grep): the `sign` job of a Pages workflow installs nothing and runs this.

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_module="${repository}/packages/core/kernel/contract/hosted-app.ts"
app_dir="${repository}/packages/app"

fail() {
  echo "❌ $*" >&2
  exit 1
}

default_origin="$(sed -n "s/^export const DEFAULT_HOSTED_APP_ORIGIN = '\(https:\/\/[^']*\)';$/\1/p" "${source_module}")"
[[ -n ${default_origin} ]] || fail "${source_module} must export DEFAULT_HOSTED_APP_ORIGIN as an https origin"

requested="$(printf '%s' "${FY_HOSTED_APP_ORIGIN:-}" | tr -d '[:space:]')"
origin="${default_origin}"
if [[ -n ${requested} ]]; then
  [[ ${requested} =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ]] ||
    fail "FY_HOSTED_APP_ORIGIN must be a plain https origin (no path, query, fragment or credentials), not '${requested}'"
  origin="${requested}"
fi

# A JSON string literal for a build define (the PEM's newlines become \n).
json_string() {
  awk 'BEGIN { printf "\"" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); printf "%s%s", sep, $0; sep = "\\n" } END { printf "\\n\"" }'
}

key_file() {
  if [[ ${origin} == "${default_origin}" ]]; then
    printf '%s\n' "${app_dir}/release-signing-key.pub"
  else
    printf '%s\n' "${app_dir}/release-signing-key.preview.pub"
  fi
}

case "${1:-}" in
'') printf '%s\n' "${origin}" ;;
--default) printf '%s\n' "${default_origin}" ;;
--key-file) key_file ;;
--next-key-file) key_file | sed 's/\.pub$/.next.pub/' ;;
--defines)
  if [[ ${origin} != "${default_origin}" ]]; then
    printf '__FY_HOSTED_APP_ORIGIN__="%s"\n' "${origin}"
    key="$(key_file)"
    if [[ -f ${key} ]]; then
      printf '__FY_HOSTED_APP_RELEASE_KEY__=%s\n' "$(json_string <"${key}")"
    else
      echo "⚠️  ${key} is not committed yet: this daemon will not trust the catalog ${origin} serves (run scripts/local/setup-pwa-release-v5.sh, commit the key)" >&2
    fi
  fi
  ;;
*) fail "usage: hosted-app-origin.sh [--default | --key-file | --next-key-file | --defines]" ;;
esac
