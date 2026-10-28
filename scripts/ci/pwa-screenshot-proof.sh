#!/usr/bin/env bash
set -euo pipefail

# The Settings surfaces, proved to fit a 390px phone and a 1440px desktop in BOTH colour schemes — and,
# for Machines, to share one left edge, pad every panel by the token, and fit the tab bar. And a session
# terminal, in every theme family, proved to draw one cell per character in a monospace face.
#
# WHAT THIS GATE IS ACTUALLY FOR, because it is not "take some screenshots".
# `packages/pwa/harness/screenshot.ts` has always been able to catch a panel whose widest value pushes
# the document past the right edge — `assertNoSidewaysScroll` reads `scrollWidth` against
# `clientWidth` on the document and on Settings' own scrollport. Nothing ran it. So the failure mode it
# defends against shipped anyway: an auto margin cancelling flex stretch clipped a surface at 390px
# with every gate in this repository green, and the Settings UI was raised five separate times before
# it was fixed. A harness that runs when somebody remembers is a harness that runs after the report.
#
# WHY THE ASSERTION AND NOT THE IMAGES.
# A capture is CLIPPED TO THE VIEWPORT, so the one defect this catches is invisible in the PNG it
# produces — a page 40px too wide screenshots as a page that looks completely fine. Committed goldens
# would therefore spend review churn on every intentional restyle while still not seeing the
# regression that actually happened. `.gitignore` already says it, and said it before this job
# existed: "screenshots are attached to PRs, never committed". The frames here are EVIDENCE, uploaded
# on success and on failure; the geometry is the gate.
#
# WHY scripts/ci AND NOT A VALIDATOR OR A TEST.
# `scripts/validate/contract-registry.sh` ties every `scripts/validate/*.sh` to the README table and a
# pre-commit hook, and a hook that builds a Tailwind bundle and launches Chromium is not something to
# put in front of every commit. A `bun test` in the int tier is the closer call and was rejected on a
# measured constraint: `packages/pwa/tests/integration/support/chromium.ts` documents that ONE browser
# is launched per int process and that no file may close it, because two first-time launches in one Bun
# process wedge the run. This harness launches and closes its own browser, so importing it into that
# tier would reintroduce the exact wedge that took three rounds to localize. `scripts/ci/` is outside
# the contract registry and enters no coverage ledger.
#
# WHY --settings-only AND NOT THE WHOLE GALLERY, with the number.
# Measured on this repository: `--settings-only` is ~19s per scheme and 57 frames; the full gallery is
# ~2m40s per scheme and 380 frames. Both call sites of `assertNoSidewaysScroll` are inside the
# Settings block, so the full gallery makes the SAME 35 checks for eight times the wall clock — it
# would buy this gate nothing and would push the job past the ~4.6min Integration Tests critical path,
# turning zero added CI wall clock into roughly two minutes of it on every push. The other `fail()`
# assertions in the gallery's later sections are real and are NOT covered by this mode.
#
# WHICH IS WHY THERE IS ALSO `full`, and why it is ONE extra leg rather than the default.
# The declared gap above is not hypothetical: #432 began parsing every file read with
# `SessionFsFileSchema`, three harness file fixtures had no `size`, and the File tab body section's
# driven Reload never got a first copy to keep — so every full run timed out in `captureFiles` for
# ~250 commits while this job stayed green, and the first to notice was an agent that needed the frames.
# `full` runs the whole gallery, so a later section that hangs or fails is red on the PR that broke it.
# It is one scheme because the later sections' assertions are about fixtures and waits, not colour, and
# a second full leg would double ~7 minutes of runner time to re-prove the same fixtures. It is a
# sibling matrix leg, so it costs runner time; its ~7 minutes sits under the E2E workflow every PR
# already waits on, which is why it adds little or no wall clock.
#
# AND WHY `full` IS TWO LEGS, ONE VIEWPORT EACH. The harness walks its viewports one after the other,
# so the full gallery took ~427s on a Namespace 4x8 and 643s on GitHub's free 4-core runner — a third
# of the Namespace bill, or the PR's critical path. A third argument names one viewport, and CI runs
# `full` as two jobs, one per viewport, on GitHub. They are separate JOBS on separate runners, which is
# what keeps this clear of #598: that ran both viewports as child processes in ONE job, three
# software-rendered Chromes on four cores, and timed out in 3 of 7 runs under load (#613 reverted it).
# The harness owes every tally PER VIEWPORT and gives each own-context pass to exactly one viewport, so
# a leg owes exactly its share, and both legs together owe what one unsplit run does.
#
# The `for` below iterates rather than substitutes because the two colour schemes are two full runs of
# a dozen steps each, and `pre-paint.js` resolves the theme before first paint — a light capture is a
# different first frame emulated at the browser context, not a class toggle inside one run.
#
# Local reproduction, identical to the job:
#   nix develop .#ci -c ./scripts/ci/pwa-screenshot-proof.sh [dark|light] [settings|full] [mobile|desktop]
#
# With no scheme it runs both in turn; CI passes one per matrix job so they run side by side. The
# scope defaults to `settings`; `full` drops `--settings-only` and walks the whole gallery. The
# viewport defaults to both, one after the other; naming one walks it alone and owes only its share.

usage() { echo "❌ usage: $0 [dark|light] [settings|full] [mobile|desktop]" >&2 && exit 2; }

schemes=(dark light)
case "${1:-}" in
"") ;;
dark | light) schemes=("$1") ;;
*) usage ;;
esac

scope="${2:-settings}"
case "${scope}" in
settings | full) ;;
*) usage ;;
esac

viewport="${3:-}"
case "${viewport}" in
"" | mobile | desktop) ;;
*) usage ;;
esac

root_dir="$(git rev-parse --show-toplevel)"
cd "${root_dir}"

# Fail early with the remedy rather than 40 seconds later inside Playwright. The int tier already
# proves a real Chromium is reachable from `nix develop .#ci` on `ubuntu-latest`, so an absent browser
# here means a changed runner image or a laptop without Chrome — two different fixes, and neither of
# them is "skip". A skip that exits 0 reads as a pass in every CI summary anybody looks at.
chrome="$(command -v google-chrome || command -v chromium || true)"
[ -z "${chrome}" ] && echo "❌ no google-chrome or chromium on PATH; this gate is a real browser or nothing" >&2 && echo "   CI gets one from the runner image, as the int tier's shared Chromium already does" >&2 && exit 2

./scripts/ci/setup.sh

artifact_dir="packages/pwa/.artifacts/pwa-screenshot"
rm -rf "${artifact_dir}"
mkdir -p "${artifact_dir}"

viewports="${viewport:-mobile + desktop}"
echo "📝 Driving ${chrome} over the ${scope} harness at ${viewports}"

for scheme in "${schemes[@]}"; do
  flags=()
  [ "${scope}" = "settings" ] && flags+=(--settings-only)
  [ "${scheme}" = "light" ] && flags+=(--light)
  [ -n "${viewport}" ] && flags+=(--viewport "${viewport}")
  log="${artifact_dir}/${scheme}.log"

  # A stale directory would hand this scheme's artifact the previous scheme's frames, which is a quiet
  # way to review the wrong picture. The harness recreates it.
  rm -rf packages/pwa/harness/out

  echo "🧪 Capturing the ${scope} harness in ${scheme}..."
  # `pipefail` is what makes `tee` safe here: without it the harness's exit status is discarded and
  # every red run would report the exit status of `tee`, which is always zero.
  #
  # `2>&1` IS LOAD-BEARING, and its absence was measured rather than imagined. The harness reports
  # failures on stderr, so a stdout-only pipe uploaded an evidence artifact whose log stopped dead
  # after the last frame it managed and never said why — on the first CI run of this gate, which found
  # a real 12px overflow. An artifact that carries every passing line and omits the failing one is
  # worse than no artifact, because it reads like a truncated success.
  (cd packages/pwa && bun harness/screenshot.ts "${flags[@]}") 2>&1 | tee "${log}"

  # THE CLOSING LINE, REQUIRED. The harness asserts its own tally and prints this only after every
  # viewport it walks has completed, so demanding it here is what separates "every check passed" from "the
  # checks stopped being reached". Without it, deleting the tally assertion upstream would leave a
  # green job that measures nothing — which is the specific way a gate like this dies.
  #
  # The EXPECTED COUNT IS NOT REPEATED HERE, and that is a deliberate trade with a named residual. The
  # harness owns that number; a copy in this script would be a second owner of one fact, and the two
  # would drift on the first legitimate surface change. So a diff that LOWERS
  # `SETTINGS_SIDEWAYS_CHECKS` to match a deleted call site still passes both checks — it is caught by
  # review, which is why that constant's own comment says to declare the new coverage in the pull
  # request. What is caught here without any review is the far likelier accident: checks that stop
  # running while the constant stays put.
  tally="$(grep '^✅ settings sideways-scroll checks: ' "${log}" || true)"
  [ -z "${tally}" ] && echo "❌ the ${scheme} run exited 0 without reporting its sideways-scroll tally" >&2 && echo "   That is not a pass: the harness prints that line only once its viewports finish, so either" >&2 && echo "   the run ended early or the tally assertion in harness/screenshot.ts was removed" >&2 && exit 1

  # The Machines geometry tally (one left edge, padding, spacing, the tab bar), required for the same
  # reason: the owner's "be careful of margins" is a gate only while its checks are still reached.
  geometry="$(grep '^✅ machines geometry checks: ' "${log}" || true)"
  [ -z "${geometry}" ] && echo "❌ the ${scheme} run exited 0 without reporting its Machines geometry tally" >&2 && echo "   The harness prints it only once its viewports finish; either the run ended early or the" >&2 && echo "   MACHINES_GEOMETRY_CHECKS assertion in harness/screenshot.ts was removed" >&2 && exit 1

  # The terminal geometry tally (one cell per character, in a monospace face, in every theme family),
  # required for the same reason: `$ bun dev` shipped as `$  b u n  d e v` with every gate green.
  terminal="$(grep '^✅ terminal geometry checks: ' "${log}" || true)"
  [ -z "${terminal}" ] && echo "❌ the ${scheme} run exited 0 without reporting its terminal geometry tally" >&2 && echo "   The harness prints it only once its viewports finish; either the run ended early or the" >&2 && echo "   TERMINAL_GEOMETRY_CHECKS assertion in harness/screenshot.ts was removed" >&2 && exit 1

  # The session page's layout tally (conversation width, the tab strip, nothing under a split pane, in
  # every theme family), required for the same reason: each of the three shipped with every gate green.
  layout="$(grep '^✅ session layout geometry checks: ' "${log}" || true)"
  [ -z "${layout}" ] && echo "❌ the ${scheme} run exited 0 without reporting its session layout geometry tally" >&2 && echo "   The harness prints it only once the pass finishes; either the run ended early or the" >&2 && echo "   SESSION_LAYOUT_GEOMETRY_CHECKS assertion in harness/screenshot.ts was removed" >&2 && exit 1

  # The bottom safe-area tally (one owner of the home-indicator inset, at rest, keyboard up and down, rotated),
  # required for the same reason: iPhones shipped a dead band twice the inset with every gate green.
  safe_area="$(grep '^✅ safe-area geometry checks: ' "${log}" || true)"
  [ -z "${safe_area}" ] && echo "❌ the ${scheme} run exited 0 without reporting its safe-area geometry tally" >&2 && echo "   The harness prints it only once the pass finishes; either the run ended early or the" >&2 && echo "   SAFE_AREA_GEOMETRY_CHECKS assertion in harness/screenshot.ts was removed" >&2 && exit 1

  # A pass the other viewport's leg owes still prints its line, naming the owner ("0/0 … owed by the
  # desktop run"), so all five lines are demanded of every leg and none is skipped by a leg it is owed by.
  #
  # A zero-byte PNG is a capture that failed in a way Playwright did not raise. Cheap to check, and it
  # keeps the artifact honest: a reviewer who opens an empty file learns nothing and blames the viewer.
  empty="$(find packages/pwa/harness/out -maxdepth 1 -name '*.png' -size 0 -print -quit)"
  [ -n "${empty}" ] && echo "❌ ${empty} was captured as an empty file in ${scheme}" >&2 && exit 1

  frames="$(find packages/pwa/harness/out -maxdepth 1 -name '*.png' -print | wc -l | tr -d ' ')"
  [ "${frames}" -eq 0 ] && echo "❌ the ${scheme} run produced no frames at all" >&2 && exit 1

  mkdir -p "${artifact_dir}/${scheme}"
  cp packages/pwa/harness/out/*.png "${artifact_dir}/${scheme}/"
  echo "📸 ${frames} ${scheme} frames -> ${artifact_dir}/${scheme}/"
done

echo "✅ The ${scope} harness passed at ${viewports} in ${schemes[*]}; frames are in ${artifact_dir}/"
