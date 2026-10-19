#!/usr/bin/env bash
set -euo pipefail

# Keeps the Namespace `/nix` cache volume (tag `ferretry-nix`) to what CI actually reads.
#
# WHY THIS EXISTS. Namespace bills a cache volume on its REQUESTED size, not on what it holds: storage
# per GB-day, and a snapshot charge of the volume's size for every minute a job has it attached. The
# dev shell and the install bundle are ~2.5GB, so the volume is requested at 10GB (the
# `nscloud-cache-size-10gb` label) instead of the 20GB default. But a store only grows: every
# `flake.lock` bump adds a new toolchain beside the old one, and nothing ever removes the old one. Left
# alone the volume fills, and a full volume fails every job that needs one more path.
#
# WHY ONLY ON `main`. Only `main` commits the volume (`nscloud-cache-allow-commit-from-main`), so a pull
# request's new paths die with its runner and the volume holds only what `main` built. Pruning anywhere
# else would prune a copy that is thrown away.
#
# WHAT SURVIVES. The `ci` dev shell every job enters and the `default` package the Build Checks job
# builds, rooted for the length of this script, and nothing else: anything unreachable from them is an
# older toolchain no current job asks for. Below the budget it does nothing at all, so a normal run
# costs one `df`.
#
# Local reproduction: none — it collects garbage from the store it runs against.

budget_gb="${FY_NIX_STORE_BUDGET_GB:-6}"

used_gb="$(df --output=used -BG /nix | tail -n 1 | tr -dc '0-9')"
echo "📝 /nix holds ${used_gb}GB of a ${budget_gb}GB budget"
[ "${used_gb}" -le "${budget_gb}" ] && echo "✅ /nix is within its budget; nothing to prune" && exit 0

roots="$(mktemp -d)"
nix develop .#ci --profile "${roots}/ci" -c true
nix build .#default --out-link "${roots}/default"
nix-collect-garbage
echo "✅ /nix pruned to $(df --output=used -BG /nix | tail -n 1 | tr -dc '0-9')GB"
