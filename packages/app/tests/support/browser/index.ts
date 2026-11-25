/**
 * Real-browser test support for every app half's integration tier, ported from today's PWA
 * (`packages/pwa/tests/integration/support`). ONE module for every plugin, because `sharedChromium` must be one
 * Chromium per test process (see `chromium.ts`): a copy per plugin would bring back the first-launch race.
 */
export { sharedChromium } from './chromium.ts';
export { boundedContext, gate, overlapped } from './overlap.ts';
export { describeRoundMisses, roundSafeMisses } from './round-safe.ts';
export { type ReleaseKey, releaseKey, run, type SignedReleaseOptions, signedRelease } from './signed-release.ts';
export { type WaitForOptions, waitFor } from './wait-for.ts';

/** The scene builder a visual test spawns as a child (`build-scene.ts` says why it is a child, never in-process). */
export const sceneBuilder: string = new URL('./build-scene.ts', import.meta.url).pathname;

/** The real-app scene server a visual test spawns as a child (`serve-scene.ts` says why it is a child and what it serves). */
export const sceneServer: string = new URL('./serve-scene.ts', import.meta.url).pathname;

export { ALL_PALETTE_IDS, COLOUR_TOOLS, type ColourTools, type TextContrastReport, textContrast } from './colour.ts';

export {
  type ArrowWalk,
  arrowWalkRings,
  type EdgeRings,
  edgeRings,
  type FocusStop,
  type FocusWalk,
  placeFromFrameTop,
  ringContrastOf,
  ringOf,
  ringOfFocused,
  walkFocusRings,
} from './focus-ring.ts';
export {
  type DemoScroll,
  demoScroll,
  type PinReading,
  type PinScroll,
  type PreviewFit,
  pinnedStrip,
  previewFit,
} from './stepper-layout.ts';
export { NEXT_SPINNER_LOG, type NextSpinnerRun } from './next-spinner-log.ts';
