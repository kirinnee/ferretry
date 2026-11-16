#!/usr/bin/env bash
set -euo pipefail

# Copy every valid store path into the local file:// binary cache.
#
# Whole-store, not just devShell closures: build-time deps (fixed-output fetches like npm
# tarballs) and packages built during the job are exactly what macOS re-builds from source
# every run when they're missing from the cache. `nix copy` checks narinfos first and skips
# paths already present, so after the first push this is incremental — new paths only.

cache_path="${1:?Usage: $0 <cache-path>}"
nix="${NIX_BIN:-nix}"

# The nix daemon (root) creates the store layout (nar/, nix-cache-info) inside the cache
# the first time it opens the file:// substituter during the build — AFTER the setup-time
# chown — leaving root-owned dirs that EACCES the push (which runs as this non-root user).
# Re-own the whole tree now, then probe the nar/ dir (where the copy actually writes).
sudo chown -R "$(id -un)" "${cache_path}/" 2>/dev/null ||
  echo "::warning::could not chown ${cache_path}; attempting push anyway" >&2
mkdir -p "${cache_path}/nar"
if ! touch "${cache_path}/nar/.write-probe" 2>/dev/null; then
  echo "::warning::${cache_path}/nar is not writable by $(id -un); skipping cache push." >&2
  exit 1
fi
rm -f "${cache_path}/nar/.write-probe"

echo "🫸 Pushing all valid store paths to file://${cache_path} (incremental)"
"$nix" copy --all --to "file://${cache_path}?compression=zstd"
echo "✅ Pushed store to local binary cache"

# STORE IMAGE MAINTENANCE (macOS only; no-op elsewhere). The image on the cache
# volume is the fast path for the next job; the file:// cache above remains the
# fallback that can always rebuild it.
[ "$(uname)" = "Darwin" ] || exit 0
img="${cache_path}/nix-store.sparseimage"

stop_daemon() {
  sudo launchctl bootout system/org.nixos.nix-daemon 2>/dev/null ||
    sudo launchctl unload /Library/LaunchDaemons/org.nixos.nix-daemon.plist 2>/dev/null || true
}

# /nix is a mount either way (the installer's APFS volume or our image) — only the
# attach step knows which; it exports DURIAN_NIX_IMAGE_ATTACHED via GITHUB_ENV.
if [ "${DURIAN_NIX_IMAGE_ATTACHED:-false}" = "true" ]; then
  # Image-backed store: stop the daemon (its binaries live inside the image) and
  # detach cleanly so the committed image is consistent. A failed detach poisons
  # the image with a marker — the job still succeeds and commits, but the next
  # run's attach step sees the marker and discards the image instead of trusting
  # a possibly-dirty filesystem.
  echo "🪂 Detaching store image"
  stop_daemon
  sync
  if sudo hdiutil detach /nix >/dev/null 2>&1 || sudo hdiutil detach /nix -force >/dev/null 2>&1; then
    rm -f "${img}.dirty"
    echo "✅ Store image detached"
  else
    touch "${img}.dirty"
    echo "::warning::could not detach /nix; poisoned the image so the next run rebuilds it" >&2
  fi
elif [ ! -f "$img" ] && [ -d /nix/store ]; then
  # No image yet: build one from the live store so the NEXT run can attach
  # instead of unpacking. One-time local copy at NVMe speed.
  echo "🏗️ Creating store image from live /nix"
  stop_daemon
  tmp_mnt="$(mktemp -d)"
  if hdiutil create -type SPARSE -fs 'Case-sensitive APFS' -size 45g -volname NixStore "$img" >/dev/null &&
    sudo hdiutil attach -mountpoint "$tmp_mnt" -nobrowse -owners on "$img" >/dev/null; then
    if sudo rsync -aH /nix/ "$tmp_mnt/"; then
      echo "✅ Store image populated ($(du -h "$img" | cut -f1))"
    else
      echo "::warning::store image population failed; removing partial image" >&2
      sudo hdiutil detach "$tmp_mnt" -force >/dev/null 2>&1 || true
      rm -f "$img"
      exit 0
    fi
    sudo hdiutil detach "$tmp_mnt" >/dev/null 2>&1 || sudo hdiutil detach "$tmp_mnt" -force >/dev/null 2>&1 || true
  else
    echo "::warning::could not create/attach store image; skipping" >&2
    rm -f "$img"
  fi
fi
