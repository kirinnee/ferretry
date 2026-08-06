#!/usr/bin/env bash
#
# Prints the hosted relay's compiled discovery ORIGIN.
#
# The PWA and daemon need this origin at BUILD time: Pages is static and the
# daemon dials nothing until the directory advertises a carrier. A relative
# `/v1/default-relay` cannot reach the separate hosted Worker.
#
# WHY THIS IS NO LONGER A RESOLVER. The former implementation selected a value
# from GitHub variables or Cloudflare credentials per build. Nix profile installs
# have neither, so Nix shipped a daemon with no directory while GoReleaser did
# not. The owner chose one compiled source default instead: the PWA and daemon
# import `HOSTED_RELAY_DIRECTORY_ORIGIN` from this file's source module on every
# build route, including Nix, local Bun builds, and forks.
#
# This script remains as a CI-facing view of that one source fact for tooling that
# previously called it. It deliberately does NOT read `HOSTED_RELAY_ORIGIN`,
# Cloudflare credentials, or the network. `--require` remains accepted for
# callers during the migration and verifies the source constant is present.
#
# The source module records two intentional temporary facts next to the literal:
# this is a personal workers.dev subdomain pending a product domain, and forks
# discover Ferretry's hosted relay by default. The runtime environment variable
# still overrides it, and an explicit daemon relay block still wins before any
# directory is asked.

set -euo pipefail

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

source_module="packages/relay/src/lib/hosted-directory-default.ts"

fail() {
  echo "❌ $1" >&2
  exit 1
}

origin="$(sed -n "s/^export const HOSTED_RELAY_DIRECTORY_ORIGIN = '\(https:\/\/[^']*\)';$/\1/p" "${source_module}")"
[[ -n ${origin} ]] || fail "${source_module} must export HOSTED_RELAY_DIRECTORY_ORIGIN as an https origin"

printf '%s\n' "${origin}"
echo "ℹ️  relay directory origin: compiled source default" >&2
