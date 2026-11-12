#!/usr/bin/env bash
set -euo pipefail

# A change to what `bun install` reads, committed without refreshing `outputHash`, used to be found
# only ten minutes into Quick Checks' Nix build (`hash mismatch in fixed-output derivation`). This gate
# finds it in seconds, at pre-commit and at the start of CI.
#
# The pin. `nix/bun-deps.inputs` holds the digest of the install inputs that `outputHash` in
# nix/ferretry.nix was last taken at. It is refreshed in the SAME commit as `outputHash`. This script
# asks Nix for the digest of the inputs as they are now and fails when the two differ.
#
# One list of inputs. The digest is nix/ferretry.nix's own `installDigest` (the one that names the
# dependency derivation): the lockfile, the root and workspace manifests without `version`, the
# vendored override files, the Bun version and the install command. This script evaluates that value
# and recomputes nothing, so the input list has exactly one owner and cannot drift from the build.
#
# Usage: bun-deps-hash.sh [--root <checkout>]    (default: the repository this script is in)

root_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
  --root)
    root_dir="${2:?--root needs a directory}"
    shift 2
    ;;
  *)
    echo "usage: $0 [--root <checkout>]" >&2
    exit 2
    ;;
  esac
done
[[ -n ${root_dir} ]] || root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

# The digest does not depend on the system: only the Bun version and the install command feed it, and
# both are the same everywhere. Evaluating one fixed system keeps the check identical on every builder.
attribute=".#packages.x86_64-linux.bunDeps"
eval_log="$(mktemp)"
trap 'rm -f "${eval_log}"' EXIT
if ! evaluated="$(nix eval --json "${attribute}" \
  --apply 'drv: { digest = drv.installDigest; pinned = drv.pinnedInstallDigest; }' 2>"${eval_log}")"; then
  {
    echo "❌ Could not evaluate the Bun install digest (nix eval ${attribute}):"
    sed 's/^/   /' "${eval_log}"
  } >&2
  exit 1
fi

digest="$(jq -r '.digest' <<<"${evaluated}")"
pinned="$(jq -r '.pinned' <<<"${evaluated}")"

if [[ ${digest} == "${pinned}" ]]; then
  echo "✅ The Bun install inputs match the digest pinned in nix/bun-deps.inputs"
  exit 0
fi

cat >&2 <<EOF
❌ The Bun install inputs changed, but outputHash was not refreshed.

   What 'bun install' reads (bun.lock, a package.json other than its "version", the vendored
   override files, the Bun version or the install command) no longer matches the digest pinned in
   nix/bun-deps.inputs. If the hash in nix/ferretry.nix stayed, the Nix build would fail ten minutes
   into Quick Checks with 'hash mismatch in fixed-output derivation'. Refresh both, in this commit:

     1. nix build .#default --no-link     (it fails with 'got: sha256-...': that is the new hash)
     2. put the got: hash into outputHash in nix/ferretry.nix
     3. echo ${digest} > nix/bun-deps.inputs
     4. nix build .#default --no-link     (it must pass now)

   pinned:  ${pinned}
   current: ${digest}

   A change that touches no production dependency (a test-only package) leaves the hash as it is:
   step 1 then passes at once, and only step 3 is needed.
EOF
exit 1
