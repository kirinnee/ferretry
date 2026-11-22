#!/usr/bin/env bash
set -euo pipefail

# Fails when a contract document names a repository path that is not tracked.
#
# `docs/fy-render.md` and `docs/reference-standard.md` tell an implementer where the code is ("the reference
# implementation is …", "the test that pins this is …"). A path that was moved or deleted turns those sentences into
# a trap that reads as an instruction: the package those documents named for a year, `packages/pwa`, no longer exists.
# `doc-paths.ts` reads the code spans and relative links of those two documents and holds each path to `git ls-files`.
# It runs on every commit and reads the whole tree, because the path that breaks a document is deleted or moved in a
# file nobody was editing the document for.
#
# Exit codes follow the repo convention: 0 clean, 1 a violation, 2 a broken gate.

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

checker="scripts/validate/doc-paths.ts"
[ ! -f "${checker}" ] && echo "❌ missing doc-paths checker: ${checker}" >&2 && exit 2
! command -v bun >/dev/null 2>&1 && echo "❌ bun is required to run ${checker}" >&2 && exit 2

exec bun "${checker}" "${root_dir}"
