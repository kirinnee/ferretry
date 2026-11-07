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
/** A fake client a suite hands a half, recorded against a daemon as the shell records the real ones. */
export { noteClientDaemon } from '../connect/daemon-of.ts';
export { RouterProvider } from './router.tsx';
export { manualScheduler } from './live-scheduler.ts';
