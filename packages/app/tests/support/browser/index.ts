/**
 * Real-browser test support for every app half's integration tier, ported from today's PWA
 * (`packages/pwa/tests/integration/support`). ONE module for every plugin, because `sharedChromium` must be one
 * Chromium per test process (see `chromium.ts`): a copy per plugin would bring back the first-launch race.
 */
export { sharedChromium } from './chromium.ts';
export { boundedContext, gate, overlapped } from './overlap.ts';
export { type ReleaseKey, releaseKey, run, type SignedReleaseOptions, signedRelease } from './signed-release.ts';
export { type WaitForOptions, waitFor } from './wait-for.ts';

/** The scene builder a visual test spawns as a child (`build-scene.ts` says why it is a child, never in-process). */
export const sceneBuilder: string = new URL('./build-scene.ts', import.meta.url).pathname;
