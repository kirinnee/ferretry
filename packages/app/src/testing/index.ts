/** Shared app test harnesses, copied from today's PWA. */
export {
  fakeCarrier,
  fakeDeviceClaims,
  type FakeCarrier,
  type FakeDeviceClaims,
  type FakeDeviceClaimsOptions,
  connector,
  pairOnLeg,
  pairOverCarriers,
  WebCryptoRelayCrypto,
} from '../connect/testing.ts';
export { noteClientDaemon } from '../connect/daemon-of.ts';
export { ensureDom, interact, type Mounted, mount, must, pressKey } from './dom.ts';
export { render, run, runAsync, runUntil } from './react.ts';
export { settleUntil } from './settle.ts';
export { RouterProvider } from './router.tsx';
export { WithAppHooks } from './app-hooks.tsx';
/** A per-daemon view's place (shell contract S1) set by hand, for a plugin suite that draws a view outside the shell. */
export { WithViewPlace } from '../shell/view-place.tsx';
/** A plugin's device view drawn as the shell draws it, over the real fragment taker (shell contract S3). */
export { type DeviceViewHarness, deviceViewHarness, fakeReachRow } from './device-view.tsx';
export { manualScheduler } from './live-scheduler.ts';
export {
  LEASE_ENDS,
  newDaemonIdentity,
  readyFrame,
  relayCrypto,
  ScriptedDaemon,
  settle as settleRelay,
  testDevice,
  testSessionId,
} from './relay.ts';
export {
  type RotatingDaemonOptions,
  type RotatingDial,
  type RotatingRequest,
  rotatingDial,
} from './rotating-daemon.ts';
