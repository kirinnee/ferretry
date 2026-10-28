#!/usr/bin/env bash
set -euo pipefail

# THE FIRST CHROME A FRESH RUNNER STARTS IS SLOW, AND NO TEST SHOULD BE THE ONE THAT PAYS FOR IT.
#
# A hosted runner's disk is cold: the first run of the image's Chrome faults its binary and resources
# in from storage, and on a slow VM that took longer than the agent browser's 20-second launch budget
# (run 40371707822: no "DevTools listening" line at all, and three dbus lines spread over seven seconds
# that a warm start writes within milliseconds). Healthy runners paid 5-12s for the same first launch,
# and the warm launches later in the failing job took about 5s. So the cost is paid here, ONCE, before
# any test's clock starts — the same headless Chrome on a throwaway profile, to a loaded page and out.
#
# A warm-up, never a gate and never a retry: it starts Chrome exactly once, and a Chrome that cannot
# start here is reported and left for the tests to fail on, where the failure names what broke.

chrome="$(command -v google-chrome || command -v chromium || true)"
[[ -z ${chrome} ]] && echo "ℹ️ no Chrome on PATH; nothing to warm" && exit 0

profile="$(mktemp -d)"
trap 'rm -rf "${profile}"' EXIT
started="${SECONDS}"
# The flags the agent browser launches with on Linux (chromeLaunchArguments), so the code it pages in is
# the code the tests then run, its software GPU process included.
timeout 120 "${chrome}" --headless=new --no-sandbox --user-data-dir="${profile}" --no-first-run \
  --no-default-browser-check --disable-component-update --disable-dev-shm-usage --use-gl=angle \
  --use-angle=swiftshader --enable-unsafe-swiftshader --password-store=basic --dump-dom about:blank \
  >/dev/null 2>&1 &&
  echo "🔥 warmed ${chrome} in $((SECONDS - started))s" ||
  echo "⚠️ ${chrome} did not finish a warm-up start in $((SECONDS - started))s; the tests will say why" >&2
