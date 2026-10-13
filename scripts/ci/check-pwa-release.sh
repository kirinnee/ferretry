#!/usr/bin/env bash
# Proves a built PWA release says only what CI decided, BEFORE it is signed and again before it is
# deployed (docs/pwa-release-signing.md).
#
#   scripts/ci/check-pwa-release.sh --sequence <n> --commit <sha> [--next-public-key <pem>]
#                                   [--public-dir <dir>] <dist>
#
# WHY. `release-manifest.json` is written by the `build` job — the runner that ran `bun install` and
# every build plugin — and a signature makes whatever it covers permanent for every installed copy. A
# malicious dependency could otherwise get a REAL signature on an attacker's `nextKey` (as good as
# stealing the key), on a huge `sequence` (every later release refused as older, forever), or on
# Pages server code (`_worker.js`, `_routes.json`, `functions/`). So every field that decides trust
# is checked against a fact the CALLING job knows on its own, from its own checkout and its own run:
#
#   - only the fields the release format has, and a well-formed version;
#   - `sequence` is the workflow run number and `commit` is the commit this run is for;
#   - `worker` is `sw.verified.js`;
#   - `nextKey` is the key in <next-public-key> (default: the checkout's
#     packages/pwa/release-signing-key.next.pub), and absent when that file is;
#   - every path is a plain relative path, and none is Pages configuration or server code (a first
#     segment starting with `_`, or `functions/`);
#   - the list names exactly the files in <dist>, each with its real SHA-256;
#   - <dist>/_headers and <dist>/_redirects are byte-for-byte the checkout's packages/pwa/public ones.
#
# openssl, coreutils and jq only (all preinstalled on the runner), so the `sign` job installs nothing.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository="${script_dir}/../.."
sequence=""
commit=""
next_public_key="${repository}/packages/pwa/release-signing-key.next.pub"
public_dir="${repository}/packages/pwa/public"
dist=""
while [[ $# -gt 0 ]]; do
  case "$1" in
  --sequence) sequence="${2:-}" && shift 2 ;;
  --commit) commit="${2:-}" && shift 2 ;;
  --next-public-key) next_public_key="${2:-}" && shift 2 ;;
  --public-dir) public_dir="${2:-}" && shift 2 ;;
  *) dist="$1" && shift ;;
  esac
done

fail() {
  echo "❌ $*" >&2
  exit 1
}

usage="usage: check-pwa-release.sh --sequence <n> --commit <sha> [--next-public-key <pem>] [--public-dir <dir>] <dist>"
[[ -n ${dist} ]] || fail "${usage}"
[[ ${sequence} =~ ^(0|[1-9][0-9]{0,14})$ ]] || fail "--sequence must be the workflow run number (${usage})"
[[ ${commit} =~ ^[0-9a-f]{7,64}$ ]] || fail "--commit must be the commit this run is for (${usage})"
manifest="${dist}/release-manifest.json"
[[ -s ${manifest} ]] || fail "${manifest} is missing or empty"
jq -e 'type == "object"' "${manifest}" >/dev/null 2>&1 || fail "${manifest} is not a JSON object"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
field() { jq -e "$1" "${manifest}" >/dev/null 2>&1 || fail "$2"; }

field '(keys - ["version","commit","sequence","createdAt","worker","files","nextKey"]) == []' \
  "the release list has a field the release format does not"
field '.version | type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")' \
  "the release version is not x.y.z"
field ".sequence == ${sequence}" "the release sequence is not this run's number (${sequence})"
field ".commit == \"${commit}\"" "the release commit is not this run's commit (${commit})"
field '.createdAt | type == "string"' "the release has no creation time"
field '.worker == "sw.verified.js"' "the release does not name sw.verified.js as its worker"
field '.files | type == "object" and has("sw.verified.js")' "the release does not list its worker"

if [[ -e ${next_public_key} ]]; then
  next="$(openssl pkey -pubin -in "${next_public_key}" -outform DER 2>/dev/null | b64url)" ||
    fail "${next_public_key} is not a public key"
  field ".nextKey == \"${next}\"" "the release announces a next key that is not ${next_public_key}"
else
  field 'has("nextKey") | not' "the release announces a next key, and ${next_public_key} does not exist"
fi

segment='[A-Za-z0-9_-][A-Za-z0-9._-]*'
field ".files | keys | all(test(\"^${segment}(/${segment})*\$\"))" "the release lists a path that is not plain"
field '.files | keys | all((startswith("_") or startswith("functions/") or . == "functions") | not)' \
  "the release lists Pages configuration or server code (_worker.js, _routes.json, functions/)"
field '.files | all(type == "string" and test("^[A-Za-z0-9_-]{43}$"))' "the release lists a hash that is not SHA-256"

[[ -z "$(find "${dist}" ! -type f ! -type d)" ]] || fail "${dist} holds something that is neither a file nor a directory"
listed="$(jq -r '.files | keys[]' "${manifest}" | LC_ALL=C sort)"
present="$(cd "${dist}" && find . -type f ! -path ./_headers ! -path ./_redirects ! -path './release-manifest.*' |
  sed 's|^\./||' | LC_ALL=C sort)"
[[ ${listed} == "${present}" ]] || {
  diff <(printf '%s\n' "${listed}") <(printf '%s\n' "${present}") >&2 || true
  fail "${manifest} does not list exactly the files in ${dist}"
}
while IFS=$'\t' read -r path hash; do
  [[ "$(openssl dgst -sha256 -binary "${dist}/${path}" | b64url)" == "${hash}" ]] ||
    fail "${path} is not the file the release lists"
done < <(jq -r '.files | to_entries[] | "\(.key)\t\(.value)"' "${manifest}")

for config in _headers _redirects; do
  cmp -s "${public_dir}/${config}" "${dist}/${config}" || fail "${dist}/${config} is not ${public_dir}/${config}"
done

echo "✅ PWA release ${sequence} (${commit}) says only what this run decided"
