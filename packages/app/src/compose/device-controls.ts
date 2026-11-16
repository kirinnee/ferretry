/**
 * THE ONE BROWSER INSTANCE OF THIS DEVICE'S CONTROLS, shared by every app half (today the app store's
 * `store.controls`). Every reader of the Enter key, the suggestion keys, the chat width or the motion choice reads
 * the same store, so a change in Settings reaches an open composer in the same tab at once.
 *
 * The instance is made on first use over `globalThis.localStorage`; a browser that refuses storage still gets a store
 * whose choices hold for this page (`browserControlsStorage` answers `undefined`). A test passes its own store.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { type DeviceControls, DaemonControlsStore, type UiControls } from './controls.ts';

let shared: DaemonControlsStore | null = null;

/** This device's controls store, made once. */
export const deviceControls = (): DaemonControlsStore => {
  shared ??= new DaemonControlsStore();
  return shared;
};

/** The device-wide controls, live, and a setter for them. */
export function useDeviceControls(store: DaemonControlsStore = deviceControls()): {
  readonly device: DeviceControls;
  readonly set: (patch: Partial<DeviceControls>) => DeviceControls;
} {
  const snapshot = useCallback(() => store.snapshot(), [store]);
  const record = useSyncExternalStore(store.subscribe, snapshot, snapshot);
  const set = useCallback((patch: Partial<DeviceControls>) => store.setDeviceControls(patch), [store]);
  return { device: record.device, set };
}

/** One daemon's merged controls (device fields plus that daemon's project scope), live, and a setter. */
export function useDaemonControls(
  daemonId: string,
  store: DaemonControlsStore = deviceControls(),
): { readonly controls: UiControls; readonly set: (patch: Partial<UiControls>) => UiControls } {
  const snapshot = useCallback(() => store.controls(daemonId), [store, daemonId]);
  const controls = useSyncExternalStore(store.subscribe, snapshot, snapshot);
  const set = useCallback((patch: Partial<UiControls>) => store.setControls(daemonId, patch), [store, daemonId]);
  return { controls, set };
}
