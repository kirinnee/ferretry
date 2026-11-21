/**
 * THE SHELL PIECES A SETUP-FLOW SCENE NEEDS, browser-safe (r11 O14 fix): a plugin's browser scene that draws its first-run
 * step inside Onboarding's REAL setup flow (so the footer's Next is the real Next) needs a device view over one fake machine
 * and a slot that places the plugin's panel. The `@ferretry/app/testing` barrel carries both, but also Node-only harnesses a
 * browser bundle cannot take, so a scene reaches just these as `@ferretry/app/testing/flow-host`.
 */
export { noteClientDaemon } from '../../../src/connect/daemon-of.ts';
export { deviceViewHarness, fakeReachRow } from '../../../src/testing/device-view.tsx';
export { type PlacedPanel, WithSlotPanels } from '../../../src/testing/slot-panels.tsx';
